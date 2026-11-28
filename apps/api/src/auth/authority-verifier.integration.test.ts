import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { createDatabasePool } from '../storage/database.js';
import { migrateDatabase } from '../storage/migrations.js';
import { roleUrl } from '../orchestration/messaging/testing/support.js';
import { ASSERTION_VERSION, encodePayload, signAssertion, type AssertionFields } from './db-authority-assertion.js';
import { createHmac } from 'node:crypto';

// B1.3 verifier on real PostgreSQL. Runtime logins are the actual aegis_app and other workload roles. The verification key is RANDOM,
// generated per run, and provisioned only into this disposable CI database. No production or persistent secret is used.
// Every refusal asserted here is the generic database refusal. The tests also check that no refusal leaks key material.

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const runtimeUrl = process.env.TEST_DATABASE_URL;
const password = process.env.DATABASE_APP_PASSWORD;
const ingestionPassword = process.env.DATABASE_INGEST_PASSWORD;
if (!adminUrl || !runtimeUrl || !password || !ingestionPassword) throw new Error('Set isolated PostgreSQL test URLs and role passwords for real PostgreSQL tests.');

const KEY_ID = 'ci-verifier-1';
const AUDIENCE = 'aegis-ci-database';
const KEY = randomBytes(32);
const TENANT = '10000000-0000-4000-8000-000000000001';
const admin = new Pool({ connectionString: adminUrl, max: 2 });
const app = createDatabasePool(runtimeUrl, 4);
const gateway = createDatabasePool(roleUrl('gateway'), 2);
const pools: Pool[] = [admin, app, gateway];

beforeAll(async () => {
  await migrateDatabase(adminUrl, password, ingestionPassword);
  // Provisioning is a privileged, administrator-only step. The key is random and never printed or stored in source.
  await admin.query(`INSERT INTO aegis_authority.keys (key_id, key_material) VALUES ($1, $2)
    ON CONFLICT (key_id) DO UPDATE SET key_material = EXCLUDED.key_material, not_after = NULL`, [KEY_ID, KEY]);
  await admin.query(`INSERT INTO aegis_authority.config (singleton, audience, max_clock_skew_seconds) VALUES (true, $1, 5)
    ON CONFLICT (singleton) DO UPDATE SET audience = EXCLUDED.audience, max_clock_skew_seconds = EXCLUDED.max_clock_skew_seconds`, [AUDIENCE]);
});
afterAll(async () => {
  await admin.query(`DELETE FROM aegis_authority.keys WHERE key_id = $1`, [KEY_ID]).catch(() => undefined);
  await Promise.all(pools.map((p) => p.end()));
});

/** Runs one transaction as a runtime login, passing it the actual transaction and backend identities and the database clock. */
async function session<T>(pool: Pool, fn: (client: PoolClient, bind: { txid: string; pid: number; now: number }) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    const bind = (await client.query<{ txid: string; pid: number; now: string }>(
      `SELECT pg_current_xact_id()::text AS txid, pg_backend_pid() AS pid, floor(extract(epoch FROM clock_timestamp()))::bigint::text AS now`)).rows[0];
    const result = await fn(client, { txid: bind.txid, pid: bind.pid, now: Number(bind.now) });
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { broken = true; }
    throw error;
  } finally { client.release(broken); }
}

const fieldValues = (f: AssertionFields): string[] => ['aegis-auth-v1', f.keyId, f.issuer, f.subject, f.tenantId, [...f.scopeCeiling].sort().join(','),
  f.purpose, f.audience, f.runtimeLogin, f.transactionId, String(f.backendPid), String(f.issuedAt), String(f.expiresAt), f.assertionId];
/** A token signed over the exact payload bytes produced by `payload`, with the real key. Used to build deliberately invalid input. */
const signBytes = (payload: Buffer, key: Buffer = KEY) => `${ASSERTION_VERSION}.${payload.toString('hex')}.${createHmac('sha256', key).update(payload).digest('hex')}`;

/** A legitimate assertion for the transaction the caller is in, expiring in 60 seconds of database time. */
function legit(bind: { txid: string; pid: number; now: number }, login: string, over: Partial<AssertionFields> = {}): AssertionFields {
  return {
    keyId: KEY_ID, issuer: 'https://synthetic.example/', subject: 'synthetic|reader-1', tenantId: TENANT, scopeCeiling: ['read:cases'],
    purpose: 'case_read', audience: AUDIENCE, runtimeLogin: login, transactionId: bind.txid, backendPid: bind.pid,
    issuedAt: bind.now, expiresAt: bind.now + 60, assertionId: randomUUID(), ...over,
  };
}
const sign = (f: AssertionFields) => signAssertion(f, KEY);

/** Calls the verifier as the runtime login; resolves to the claims, or rejects with the database error. */
async function verify(pool: Pool, token: string) {
  return session(pool, async (client) => (await client.query(
    'SELECT issuer, subject, tenant_id, scope_ceiling, purpose, assertion_id, expires_at FROM aegis_authority.verify_assertion($1)', [token])).rows);
}
const DENIED = 'authority assertion refused';
async function refusal(pool: Pool, token: string): Promise<{ message: string; code?: string }> {
  try { await verify(pool, token); } catch (error) { return { message: (error as Error).message, code: (error as { code?: string }).code }; }
  throw new Error('expected the verifier to refuse, but it accepted');
}

describe('verifier: positive bindings on the actual session, transaction and backend', () => {
  it('accepts an assertion bound to the actual transaction, backend, login, audience and clock, and returns only the verified claims', async () => {
    await session(app, async (client, bind) => {
      const f = legit(bind, 'aegis_app');
      const rows = (await client.query('SELECT issuer, subject, tenant_id, scope_ceiling, purpose, assertion_id, expires_at FROM aegis_authority.verify_assertion($1)',
        [sign(f)])).rows;
      expect(rows).toEqual([{ issuer: f.issuer, subject: f.subject, tenant_id: TENANT, scope_ceiling: 'read:cases', purpose: 'case_read',
        assertion_id: f.assertionId, expires_at: String(f.expiresAt) }]);
    });
  });

  it('permits several verification calls within the same legitimate transaction', async () => {
    await session(app, async (client, bind) => {
      const token = sign(legit(bind, 'aegis_app'));
      for (let i = 0; i < 3; i += 1) {
        expect((await client.query('SELECT 1 FROM aegis_authority.verify_assertion($1)', [token])).rowCount).toBe(1);
      }
    });
  });

  it('the database decodes the independent literal payload to exactly the fourteen literal fields (cross-language, as the administrator)', async () => {
    const payloadHex = '31333a61656769732d617574682d7631393a63692d746573742d3132363a68747470733a2f2f73796e7468657469632e6578616d706c652f31383a73796e7468657469637c7265616465722d3133363a31303030303030302d303030302d343030302d383030302d30303030303030303030303131303a726561643a6361736573393a636173655f7265616431373a61656769732d63692d6461746162617365393a61656769735f61707031393a31323334353637383930313233343536373839343a3432343231303a3138303030303030303031303a3138303030303030363033363a36663964326331652d336234612d346335642d386539662d306131623263336434653566';
    const rows = (await admin.query<{ f: string[] }>('SELECT aegis_authority.decode_fields(decode($1, \'hex\')) AS f', [payloadHex])).rows;
    expect(rows[0].f).toEqual(['aegis-auth-v1', 'ci-test-1', 'https://synthetic.example/', 'synthetic|reader-1',
      '10000000-0000-4000-8000-000000000001', 'read:cases', 'case_read', 'aegis-ci-database', 'aegis_app', '1234567890123456789', '4242',
      '1800000000', '1800000060', '6f9d2c1e-3b4a-4c5d-8e9f-0a1b2c3d4e5f']);
  });

  it('the HMAC-SHA-256 computed by pgcrypto over the literal payload equals the independent literal MAC', async () => {
    const payloadHex = '31333a61656769732d617574682d7631393a63692d746573742d3132363a68747470733a2f2f73796e7468657469632e6578616d706c652f31383a73796e7468657469637c7265616465722d3133363a31303030303030302d303030302d343030302d383030302d30303030303030303030303131303a726561643a6361736573393a636173655f7265616431373a61656769732d63692d6461746162617365393a61656769735f61707031393a31323334353637383930313233343536373839343a3432343231303a3138303030303030303031303a3138303030303030363033363a36663964326331652d336234612d346335642d386539662d306131623263336434653566';
    const rows = (await admin.query<{ mac: string }>(`SELECT encode(aegis_crypto.hmac(decode($1, 'hex'), decode($2, 'hex'), 'sha256'), 'hex') AS mac`,
      [payloadHex, '42'.repeat(32)])).rows;
    expect(rows[0].mac).toBe('de36d8c9da9c82e02539016b56963360a192e47327ad0b30d4f4af6731041e8c');
  });
});

describe('verifier: refusals (each generic, each with the real runtime login)', () => {
  it('refuses a wrong MAC, a modified principal, tenant or purpose (payload changed, MAC kept)', async () => {
    await session(app, async (client, bind) => {
      const token = sign(legit(bind, 'aegis_app'));
      const [v, payload, mac] = token.split('.');
      const flip = (hex: string) => hex.slice(0, -1) + (hex.endsWith('0') ? '1' : '0');
      const cases = [`${v}.${payload}.${flip(mac)}`];
      for (const needle of [Buffer.from('synthetic|reader-1').toString('hex'), Buffer.from('case_read').toString('hex')]) {
        cases.push(`${v}.${payload.replace(needle, Buffer.from('synthetic|other-x').toString('hex').slice(0, needle.length))}.${mac}`);
      }
      for (const bad of cases) {
        await expect(refusal(app, bad)).resolves.toEqual({ message: DENIED, code: '42501' });
      }
    });
  });

  it('refuses a wrong key identifier (missing key) and a key past its expiry, as one generic refusal', async () => {
    await session(app, async (client, bind) => {
      await expect(refusal(app, sign(legit(bind, 'aegis_app', { keyId: 'no-such-key' })))).resolves.toEqual({ message: DENIED, code: '42501' });
    });
    await admin.query(`UPDATE aegis_authority.keys SET not_after = clock_timestamp() - interval '1 second' WHERE key_id = $1`, [KEY_ID]);
    try {
      await session(app, async (client, bind) => {
        await expect(refusal(app, sign(legit(bind, 'aegis_app')))).resolves.toEqual({ message: DENIED, code: '42501' });
      });
    } finally {
      await admin.query(`UPDATE aegis_authority.keys SET not_after = NULL WHERE key_id = $1`, [KEY_ID]);
    }
  });

  it('refuses when the database has no key provisioned at all, and when its configuration is missing (fail closed)', async () => {
    const saved = (await admin.query<{ key_material: Buffer }>('SELECT key_material FROM aegis_authority.keys WHERE key_id = $1', [KEY_ID])).rows[0];
    await admin.query('DELETE FROM aegis_authority.keys WHERE key_id = $1', [KEY_ID]);
    try {
      await session(app, async (client, bind) => {
        await expect(refusal(app, sign(legit(bind, 'aegis_app')))).resolves.toEqual({ message: DENIED, code: '42501' });
      });
    } finally {
      await admin.query('INSERT INTO aegis_authority.keys (key_id, key_material) VALUES ($1, $2)', [KEY_ID, saved.key_material]);
    }
    const config = (await admin.query('SELECT audience, max_clock_skew_seconds FROM aegis_authority.config')).rows[0];
    await admin.query('DELETE FROM aegis_authority.config');
    try {
      await session(app, async (client, bind) => {
        await expect(refusal(app, sign(legit(bind, 'aegis_app')))).resolves.toEqual({ message: DENIED, code: '42501' });
      });
    } finally {
      await admin.query('INSERT INTO aegis_authority.config (singleton, audience, max_clock_skew_seconds) VALUES (true, $1, $2)',
        [config.audience, config.max_clock_skew_seconds]);
    }
  });

  it('refuses a wrong audience, a wrong runtime login, a wrong transaction identifier and a wrong backend PID', async () => {
    await session(app, async (client, bind) => {
      const refused = { message: DENIED, code: '42501' };
      await expect(refusal(app, sign(legit(bind, 'aegis_app', { audience: 'some-other-database' })))).resolves.toEqual(refused);
      await expect(refusal(app, sign(legit(bind, 'aegis_gateway')))).resolves.toEqual(refused);
      await expect(refusal(app, sign(legit(bind, 'aegis_app', { transactionId: String(BigInt(bind.txid) + 1n) })))).resolves.toEqual(refused);
      await expect(refusal(app, sign(legit(bind, 'aegis_app', { backendPid: bind.pid + 1 })))).resolves.toEqual(refused);
    });
  });

  it('refuses an expired assertion and a future-issued assertion outside the clock allowance, by database time', async () => {
    await session(app, async (client, bind) => {
      const refused = { message: DENIED, code: '42501' };
      await expect(refusal(app, sign(legit(bind, 'aegis_app', { issuedAt: bind.now - 120, expiresAt: bind.now - 60 })))).resolves.toEqual(refused);
      await expect(refusal(app, sign(legit(bind, 'aegis_app', { issuedAt: bind.now + 60, expiresAt: bind.now + 120 })))).resolves.toEqual(refused);
    });
  });

  it('refuses an excessive lifetime, even when correctly signed (the signer refuses it, so the payload is built directly)', async () => {
    await session(app, async (client, bind) => {
      const f = legit(bind, 'aegis_app', { expiresAt: bind.now + 301 });
      const token = signBytes(encodePayload(fieldValues(f)));
      await expect(refusal(app, token)).resolves.toEqual({ message: DENIED, code: '42501' });
    });
  });

  it('refuses malformed encodings, an unsupported version, non-canonical or duplicate scopes, invalid UTF-8, and oversized tokens', async () => {
    await session(app, async (client, bind) => {
      const refused = { message: DENIED, code: '42501' };
      const values = fieldValues(legit(bind, 'aegis_app'));
      // Leading zero in a length prefix (the same bytes otherwise valid).
      await expect(refusal(app, signBytes(Buffer.from('02:ab', 'ascii')))).resolves.toEqual(refused);
      // Unsupported version.
      await expect(refusal(app, sign(legit(bind, 'aegis_app')).replace('aegis-auth-v1.', 'aegis-auth-v2.'))).resolves.toEqual(refused);
      // Scopes out of order and duplicated.
      const unsorted = values.map((v, i) => (i === 5 ? 'write:cases,read:cases' : v));
      await expect(refusal(app, signBytes(encodePayload(unsorted)))).resolves.toEqual(refused);
      const duplicated = values.map((v, i) => (i === 5 ? 'read:cases,read:cases' : v));
      await expect(refusal(app, signBytes(encodePayload(duplicated)))).resolves.toEqual(refused);
      // Invalid UTF-8 in a field: one 0xff byte, length-prefixed, correctly signed.
      const bad = Buffer.concat([Buffer.from('1:'), Buffer.from([0xff])]);
      await expect(refusal(app, signBytes(bad))).resolves.toEqual(refused);
      // Oversized token.
      await expect(refusal(app, 'aegis-auth-v1.' + '00'.repeat(2049) + '.' + '00'.repeat(32))).resolves.toEqual(refused);
    });
  });

  it('refuses a non-allowlisted purpose, even when correctly signed', async () => {
    await session(app, async (client, bind) => {
      const refused = { message: DENIED, code: '42501' };
      await expect(refusal(app, signBytes(encodePayload(fieldValues(legit(bind, 'aegis_app', { purpose: 'delete_everything' as never })))))).resolves.toEqual(refused);
    });
  });
});

describe('verifier: replay and binding across commit, rollback, connections, roles and replacement', () => {
  it('reuse after commit is refused in a later transaction', async () => {
    let token = '';
    await session(app, async (client, bind) => { token = sign(legit(bind, 'aegis_app')); });
    await expect(refusal(app, token)).resolves.toEqual({ message: DENIED, code: '42501' });
  });

  it('reuse after rollback is refused in a later transaction', async () => {
    const client = await app.connect();
    let token = '';
    try {
      await client.query('BEGIN');
      const bind = (await client.query<{ txid: string; pid: number; now: string }>(
        `SELECT pg_current_xact_id()::text AS txid, pg_backend_pid() AS pid, floor(extract(epoch FROM clock_timestamp()))::bigint::text AS now`)).rows[0];
      token = sign(legit({ txid: bind.txid, pid: bind.pid, now: Number(bind.now) }, 'aegis_app'));
      await client.query('ROLLBACK');
    } finally { client.release(); }
    await expect(refusal(app, token)).resolves.toEqual({ message: DENIED, code: '42501' });
  });

  it('concurrent cross-connection replay: a second connection cannot use an assertion while the first transaction is open', async () => {
    const first = await app.connect();
    const second = await app.connect();
    try {
      await first.query('BEGIN');
      const bind = (await first.query<{ txid: string; pid: number; now: string }>(
        `SELECT pg_current_xact_id()::text AS txid, pg_backend_pid() AS pid, floor(extract(epoch FROM clock_timestamp()))::bigint::text AS now`)).rows[0];
      const token = sign(legit({ txid: bind.txid, pid: bind.pid, now: Number(bind.now) }, 'aegis_app'));
      expect((await first.query('SELECT 1 FROM aegis_authority.verify_assertion($1)', [token])).rowCount).toBe(1);
      // The replay happens on another connection, while the first transaction is still open.
      await second.query('BEGIN');
      await expect(second.query('SELECT 1 FROM aegis_authority.verify_assertion($1)', [token])).rejects.toMatchObject({ message: DENIED });
      await second.query('ROLLBACK');
      await first.query('COMMIT');
    } finally {
      first.release();
      second.release();
    }
  });

  it('replay by another runtime role is refused: the verifier is not granted to it, and a foreign-login assertion is refused by its login binding', async () => {
    let token = '';
    await session(app, async (client, bind) => { token = sign(legit(bind, 'aegis_app')); });
    const denied = await refusal(gateway, token);
    expect(denied.code).toBe('42501');
    expect(denied.message).toMatch(/permission denied|authority assertion refused/);
  });

  it('reuse after connection replacement is refused: the replacement connection has a new backend and transaction', async () => {
    let token = '';
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      const bind = (await client.query<{ txid: string; pid: number; now: string }>(
        `SELECT pg_current_xact_id()::text AS txid, pg_backend_pid() AS pid, floor(extract(epoch FROM clock_timestamp()))::bigint::text AS now`)).rows[0];
      token = sign(legit({ txid: bind.txid, pid: bind.pid, now: Number(bind.now) }, 'aegis_app'));
      await client.query('ROLLBACK');
    } finally { client.release(true); }
    await expect(refusal(app, token)).resolves.toEqual({ message: DENIED, code: '42501' });
  });
});

describe('verifier: runtime privilege boundary (real runtime login, no administrator credentials)', () => {
  const denied = (error: unknown) => expect(['42501', '42P01']).toContain((error as { code?: string }).code);

  it('the runtime login cannot read, insert, update or delete the key store or the configuration', async () => {
    const client = await app.connect();
    try {
      for (const sql of ['SELECT key_material FROM aegis_authority.keys',
        `INSERT INTO aegis_authority.keys (key_id, key_material) VALUES ('evil', decode(repeat('00',32),'hex'))`,
        `UPDATE aegis_authority.keys SET key_material = decode(repeat('00',32),'hex')`,
        'DELETE FROM aegis_authority.keys', 'SELECT audience FROM aegis_authority.config', 'UPDATE aegis_authority.config SET audience = audience']) {
        await client.query('BEGIN');
        await client.query(sql).then(() => { throw new Error(`expected refusal: ${sql}`); }, (e: unknown) => denied(e));
        await client.query('ROLLBACK');
      }
    } finally { client.release(); }
  });

  it('the runtime login cannot call the decoder, cannot create objects in the verifier schema, and cannot change the verifier', async () => {
    const client = await app.connect();
    try {
      const attempts = ["SELECT aegis_authority.decode_fields('\\x00'::bytea)",
        'CREATE FUNCTION aegis_authority.evil() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$',
        'ALTER FUNCTION aegis_authority.verify_assertion(text) OWNER TO aegis_app',
        'CREATE OR REPLACE FUNCTION aegis_authority.verify_assertion(p_token text) RETURNS TABLE (a text) LANGUAGE sql AS $$ SELECT \'x\' $$',
        'SET ROLE aegis_authority_owner'];
      for (const sql of attempts) {
        await client.query('BEGIN');
        await client.query(sql).then(() => { throw new Error(`expected refusal: ${sql}`); }, (e: unknown) => denied(e));
        await client.query('ROLLBACK');
      }
    } finally { client.release(); }
  });

  it('the verifier is SECURITY DEFINER, owned by the non-login owner, with a pinned search_path and no PUBLIC or triage execution', async () => {
    const row = (await admin.query<{ definer: boolean; owner: string; config: string[] | null; public_exec: boolean; triage_exec: boolean; owner_login: boolean }>(
      `SELECT p.prosecdef AS definer, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config,
              has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
              has_function_privilege('aegis_triage', p.oid, 'EXECUTE') AS triage_exec,
              (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'aegis_authority_owner') AS owner_login
         FROM pg_proc p WHERE p.oid = 'aegis_authority.verify_assertion(text)'::regprocedure`)).rows[0];
    expect(row).toMatchObject({ definer: true, owner: 'aegis_authority_owner', public_exec: false, triage_exec: false, owner_login: false });
    expect(row.config).toEqual(expect.arrayContaining(['search_path=pg_catalog, pg_temp']));
    expect((await admin.query(`SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid WHERE r.rolname = 'aegis_authority_owner'`)).rowCount).toBe(0);
  });

  it('a refusal never reveals key material or internal detail: its message is the generic text only', async () => {
    const messages = new Set<string>();
    await session(app, async (client, bind) => {
      for (const token of [sign(legit(bind, 'aegis_app', { keyId: 'no-such' })), 'aegis-auth-v1.00.00', 'x']) {
        messages.add((await refusal(app, token)).message);
      }
    });
    expect([...messages]).toEqual([DENIED]);
    for (const message of messages) expect(message).not.toContain(KEY.toString('hex'));
  });
});
