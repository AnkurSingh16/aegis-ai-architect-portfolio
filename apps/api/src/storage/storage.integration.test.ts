import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { CaseRepository } from './cases.js';
import { resolveFixture } from './config.js';
import { createDatabasePool, verifyRuntimeRole, withTenantTransaction } from './database.js';
import { migrateDatabase, migrationsDirectory } from './migrations.js';
import { withAuthenticatedTransaction } from '../auth/transaction.js';
import type { VerifiedPrincipal } from '../auth/token.js';

// Integration tests deliberately fail without explicit, separate test database configuration.
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const runtimeUrl = process.env.TEST_DATABASE_URL;
const password = process.env.DATABASE_APP_PASSWORD;
const ingestionPassword = process.env.DATABASE_INGEST_PASSWORD;
if (!adminUrl || !runtimeUrl || !password || !ingestionPassword) throw new Error('Set isolated PostgreSQL test URLs and role passwords for real PostgreSQL tests.');
for (const [label, value] of [['admin', adminUrl], ['runtime', runtimeUrl]] as const) {
  const parsed = new URL(value);
  if (parsed.pathname !== '/aegis_test' || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
    throw new Error(`Integration ${label} connection must target loopback aegis_test.`);
  }
}
const north = resolveFixture('north');
const south = resolveFixture('south');
const log = vi.fn();
const pool = createDatabasePool(runtimeUrl, 4);
const single = createDatabasePool(runtimeUrl, 1);
const admin = new Pool({ connectionString: adminUrl, max: 1 });
const a = new CaseRepository(pool, north, log);
const b = new CaseRepository(pool, south, log);
let northId: string;
let southId: string;
const documentIssuer = 'https://synthetic-docs.auth0.example/';
const documentNorthSubject = `synthetic-docs|north-${randomUUID()}`;
const documentSouthSubject = `synthetic-docs|south-${randomUUID()}`;
const documentPrefix = `SYNTHETIC-TEST-${randomUUID().toUpperCase()}`;
const northChunkContent = 'North synthetic chunk.';
const southChunkContent = 'South synthetic chunk.';
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const documents = {
  north: { id: randomUUID(), tenantId: north.tenantId, sourceIdentity: `${documentPrefix}-NORTH`, version: 1,
    contentHash: sha256('North synthetic source document.') },
  south: { id: randomUUID(), tenantId: south.tenantId, sourceIdentity: `${documentPrefix}-SOUTH`, version: 2,
    contentHash: sha256('South synthetic source document.') },
};
const chunks = {
  north: { id: randomUUID(), documentId: documents.north.id, sourceIdentity: documents.north.sourceIdentity, tenantId: north.tenantId, version: 1,
    position: 0, content: northChunkContent, contentHash: sha256(northChunkContent) },
  south: { id: randomUUID(), documentId: documents.south.id, sourceIdentity: documents.south.sourceIdentity, tenantId: south.tenantId, version: 2,
    position: 0, content: southChunkContent, contentHash: sha256(southChunkContent) },
};

function documentPrincipal(subject: string): VerifiedPrincipal {
  return { issuer: documentIssuer, subject, scopes: new Set(['read:cases']) };
}

async function rawDocumentContext(context: { mode?: string; issuer?: string; subject?: string; tenant?: string },
  operation: (client: import('pg').PoolClient) => Promise<unknown>): Promise<unknown> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('aegis.access_mode',$1,true), set_config('aegis.principal_issuer',$2,true),
      set_config('aegis.principal_subject',$3,true), set_config('aegis.tenant_id',$4,true)`,
    [context.mode ?? '', context.issuer ?? '', context.subject ?? '', context.tenant ?? '']);
    return await operation(client);
  } finally { await client.query('ROLLBACK'); client.release(); }
}

beforeAll(async () => {
  await migrateDatabase(adminUrl, password, ingestionPassword);
  await verifyRuntimeRole(pool);
  await admin.query(`INSERT INTO aegis.memberships (issuer, subject, tenant_id, role) VALUES
    ($1,$2,$3,'reader'), ($1,$4,$5,'reader')`,
  [documentIssuer, documentNorthSubject, north.tenantId, documentSouthSubject, south.tenantId]);
  for (const document of Object.values(documents)) {
    await admin.query(`INSERT INTO aegis.documents
      (id, tenant_id, source_identity, version, source_owner, ingestion_source, ingestion_revision, content_sha256, metadata)
      VALUES ($1,$2,$3,$4,'Aegis synthetic corpus','source-controlled-synthetic-catalog','m4.1-test',$5,'{}'::jsonb)`,
    [document.id, document.tenantId, document.sourceIdentity, document.version, document.contentHash]);
  }
  for (const chunk of Object.values(chunks)) {
    await admin.query(`INSERT INTO aegis.document_chunks
      (id, tenant_id, document_id, document_version, source_identity, position, content, content_sha256)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [chunk.id, chunk.tenantId, chunk.documentId, chunk.version, chunk.sourceIdentity, chunk.position, chunk.content, chunk.contentHash]);
  }
  northId = (await a.create('SYNTHETIC-LOGIN-001')).id;
  southId = (await b.create('SYNTHETIC-BILLING-002')).id;
}, 30000);
afterAll(async () => {
  try {
    await admin.query('DELETE FROM aegis.document_chunks WHERE document_id = ANY($1::uuid[])', [[documents.north.id, documents.south.id]]);
    await admin.query('DELETE FROM aegis.documents WHERE id = ANY($1::uuid[])', [[documents.north.id, documents.south.id]]);
    await admin.query('DELETE FROM aegis.memberships WHERE issuer = $1 AND subject = ANY($2::text[])',
      [documentIssuer, [documentNorthSubject, documentSouthSubject]]);
  } finally { await Promise.all([pool.end(), single.end(), admin.end()]); }
});

describe('real PostgreSQL persistence and role boundary', () => {
  it('replays migrations without changing the schema and rejects checksum changes', async () => {
    expect(await migrateDatabase(adminUrl, password, ingestionPassword)).toBe(0);
    const migrationText = await readFile(new URL('003_tenant_documents.sql', migrationsDirectory), 'utf8');
    const migrationChecksum = createHash('sha256').update(migrationText).digest('hex');
    expect((await admin.query('SELECT checksum FROM aegis_migrations.versions WHERE version = $1',
      ['003_tenant_documents.sql'])).rows).toEqual([{ checksum: migrationChecksum }]);
    const directory = await mkdtemp(join(tmpdir(), 'aegis-migrations-'));
    try {
      for (const file of await readdir(migrationsDirectory)) {
        await writeFile(join(directory, file), await readFile(new URL(file, migrationsDirectory), 'utf8'));
      }
      const sql = await readFile(new URL('003_tenant_documents.sql', migrationsDirectory), 'utf8');
      await writeFile(join(directory, '003_tenant_documents.sql'), `${sql}\n-- modified migration\n`);
      await expect(migrateDatabase(adminUrl, password, ingestionPassword, pathToFileURL(`${directory}/`))).rejects.toThrow('modified');
    } finally { await rm(directory, { recursive: true, force: true }); }
    expect(await migrateDatabase(adminUrl, password, ingestionPassword)).toBe(0);
  });

  it('rejects missing, duplicate and out-of-order migration histories', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aegis-history-'));
    try {
      const url = pathToFileURL(`${directory}/`);
      await expect(migrateDatabase(adminUrl, password, ingestionPassword, url)).rejects.toThrow('present and unique');
      await writeFile(join(directory, '002_placeholder.sql'), 'SELECT 1;');
      await expect(migrateDatabase(adminUrl, password, ingestionPassword, url)).rejects.toThrow('missing');
      for (const file of await readdir(migrationsDirectory)) {
        await writeFile(join(directory, file), await readFile(new URL(file, migrationsDirectory), 'utf8'));
      }
      const sql = await readFile(new URL('001_multitenant.sql', migrationsDirectory), 'utf8');
      await writeFile(join(directory, '001_multitenant.sql'), sql);
      await writeFile(join(directory, '001_duplicate.sql'), 'SELECT 1;');
      await expect(migrateDatabase(adminUrl, password, ingestionPassword, url)).rejects.toThrow('present and unique');
      await rm(join(directory, '001_duplicate.sql'));
      await rm(join(directory, '002_placeholder.sql'));
      await writeFile(join(directory, '000_earlier.sql'), 'SELECT 1;');
      await expect(migrateDatabase(adminUrl, password, ingestionPassword, url)).rejects.toThrow('Out-of-order');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('connects as a nonowner without elevated attributes, memberships or schema administration', async () => {
    await expect(verifyRuntimeRole(pool)).resolves.toBeUndefined();
    await expect(verifyRuntimeRole(admin)).rejects.toThrow('Unsafe');
    const role = await pool.query(`SELECT current_user, rolsuper, rolbypassrls, rolcreatedb,
      rolcreaterole, rolinherit, rolreplication FROM pg_roles WHERE rolname = current_user`);
    expect(role.rows[0]).toEqual({ current_user: 'aegis_app', rolsuper: false, rolbypassrls: false,
      rolcreatedb: false, rolcreaterole: false, rolinherit: false, rolreplication: false });
    const tables = await pool.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
      pg_get_userbyid(c.relowner) = current_user AS owned
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'aegis' AND c.relkind = 'r' ORDER BY c.relname`);
    expect(tables.rows.map((row) => row.relname)).toEqual([
      'audit_events', 'document_chunks', 'documents', 'memberships', 'support_cases', 'tenants',
    ]);
    for (const table of tables.rows) expect(table).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true, owned: false });
    expect((await pool.query(`SELECT count(*)::int AS count FROM pg_auth_members
      WHERE member = (SELECT oid FROM pg_roles WHERE rolname = current_user)
         OR roleid = (SELECT oid FROM pg_roles WHERE rolname = current_user)`)).rows[0].count).toBe(0);
    const administrator = (await admin.query('SELECT current_user')).rows[0].current_user as string;
    for (const sql of [`SET ROLE "${administrator.replaceAll('"', '""')}"`,
      'ALTER TABLE aegis.support_cases DISABLE ROW LEVEL SECURITY',
      'ALTER TABLE aegis.support_cases DISABLE TRIGGER ALL',
      'CREATE TABLE aegis.unauthorized (id integer)',
      'CREATE TABLE public.unauthorized (id integer)',
      'TRUNCATE aegis.support_cases',
      'SELECT * FROM aegis_migrations.versions']) {
      await expect(pool.query(sql)).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('rejects runtime-role membership whether aegis_app inherits a role or other roles inherit aegis_app', async () => {
    const probeRole = `aegis_m4_role_probe_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE ROLE ${probeRole} NOLOGIN`);
    try {
      await admin.query(`GRANT ${probeRole} TO aegis_app`);
      await expect(verifyRuntimeRole(pool)).rejects.toThrow('Unsafe application database role or schema.');
      await admin.query(`REVOKE ${probeRole} FROM aegis_app`);

      await admin.query(`GRANT aegis_app TO ${probeRole}`);
      await expect(verifyRuntimeRole(pool)).rejects.toThrow('Unsafe application database role or schema.');
      await admin.query(`REVOKE aegis_app FROM ${probeRole}`);
    } finally {
      await admin.query(`REVOKE ${probeRole} FROM aegis_app`).catch(() => {});
      await admin.query(`REVOKE aegis_app FROM ${probeRole}`).catch(() => {});
      await admin.query(`DROP ROLE IF EXISTS ${probeRole}`);
    }
    await expect(verifyRuntimeRole(pool)).resolves.toBeUndefined();
  });

  it('persists synthetic cases across independent pools and retains deterministic triage', async () => {
    const updated = await a.update(northId, 'in_progress');
    expect(updated).toMatchObject({ id: northId, tenant_id: north.tenantId, status: 'in_progress' });
    const anotherPool = createDatabasePool(runtimeUrl, 1);
    try {
      expect(await new CaseRepository(anotherPool, north, log).read(northId)).toMatchObject({ status: 'in_progress' });
      expect(await a.triage(northId)).toMatchObject({ mode: 'synthetic-mock', caseId: 'SYNTHETIC-LOGIN-001' });
    } finally { await anotherPool.end(); }
    expect((await a.list()).every((row) => row.tenant_id === north.tenantId)).toBe(true);
  });

  it('records creation and status changes atomically, with append-only runtime access', async () => {
    const created = await a.create('SYNTHETIC-GUIDANCE-003');
    await a.update(created.id, 'resolved');
    expect(await a.audit(created.id)).toMatchObject([
      { tenant_id: north.tenantId, case_id: created.id, action: 'case.created', previous_status: null, new_status: 'open' },
      { tenant_id: north.tenantId, case_id: created.id, action: 'case.updated', previous_status: 'open', new_status: 'resolved' },
    ]);
    for (const sql of [
      'INSERT INTO aegis.audit_events (tenant_id, case_id, action, new_status) VALUES ($1, $2, \'case.created\', \'open\')',
      'UPDATE aegis.audit_events SET new_status = \'open\' WHERE tenant_id = $1 AND case_id = $2',
      'DELETE FROM aegis.audit_events WHERE tenant_id = $1 AND case_id = $2',
    ]) {
      await expect(withTenantTransaction(pool, north, (client) => client.query(sql, [north.tenantId, created.id])))
        .rejects.toMatchObject({ code: '42501' });
    }
  });
});

describe('default-deny tenant isolation in real SQL', () => {
  it('hides foreign cases and audits without revealing whether IDs exist', async () => {
    await expect(a.read(southId)).rejects.toMatchObject({ code: 'not_found' });
    await expect(a.update(southId, 'resolved')).rejects.toMatchObject({ code: 'not_found' });
    await expect(b.read(northId)).rejects.toMatchObject({ code: 'not_found' });
    expect(await a.audit(southId)).toEqual([]);
    await withTenantTransaction(pool, north, async (client) => {
      expect((await client.query('SELECT * FROM aegis.tenants')).rows).toEqual([{ id: north.tenantId, name: north.name }]);
      expect((await client.query('SELECT * FROM aegis.support_cases WHERE id = $1', [southId])).rows).toEqual([]);
      expect((await client.query('SELECT * FROM aegis.audit_events WHERE case_id = $1', [southId])).rows).toEqual([]);
      expect((await client.query('UPDATE aegis.support_cases SET status = \'resolved\' WHERE id = $1', [southId])).rowCount).toBe(0);
    });
  });

  it('rejects foreign tenant INSERT and tenant reassignment even with valid SQL', async () => {
    await expect(withTenantTransaction(pool, north, (client) => client.query(
      'INSERT INTO aegis.support_cases (tenant_id, synthetic_case_id) VALUES ($1, $2)',
      [south.tenantId, 'SYNTHETIC-LOGIN-001']))).rejects.toMatchObject({ code: '42501' });
    await expect(withTenantTransaction(pool, north, (client) => client.query(
      'UPDATE aegis.support_cases SET tenant_id = $1 WHERE id = $2', [south.tenantId, northId])))
      .rejects.toMatchObject({ code: '42501' });
    expect((await b.read(southId)).status).toBe('open');
  });

  it('denies all reads and writes without tenant context', async () => {
    for (const table of ['tenants', 'support_cases', 'audit_events']) {
      expect((await single.query(`SELECT * FROM aegis.${table}`)).rows).toEqual([]);
    }
    expect((await single.query('UPDATE aegis.support_cases SET status = \'resolved\'')).rowCount).toBe(0);
    await expect(single.query('INSERT INTO aegis.support_cases (tenant_id, synthetic_case_id) VALUES ($1, $2)',
      [north.tenantId, 'SYNTHETIC-LOGIN-001'])).rejects.toMatchObject({ code: '42501' });
    await expect(withTenantTransaction(single, north, async (client) => {
      await client.query("SELECT set_config('row_security', 'off', true)");
      await client.query('SELECT * FROM aegis.support_cases');
    })).rejects.toMatchObject({ code: '42501' });
    expect((await single.query('SELECT * FROM aegis.support_cases')).rows).toEqual([]);
  });

  it('rejects malformed values at application and database boundaries', async () => {
    for (const value of [null, {}, 'real customer', "' OR 1=1 --", '']) {
      await expect(a.create(value)).rejects.toMatchObject({ code: 'invalid_input' });
      await expect(a.read(value)).rejects.toMatchObject({ code: 'invalid_input' });
      await expect(a.update(northId, value)).rejects.toMatchObject({ code: 'invalid_input' });
    }
    await expect(withTenantTransaction(pool, north, (client) => client.query(
      'INSERT INTO aegis.support_cases (tenant_id, synthetic_case_id) VALUES ($1, $2)', [north.tenantId, 'arbitrary-input'])))
      .rejects.toMatchObject({ code: '23514' });
    await expect(withTenantTransaction(pool, north, (client) => client.query(
      'UPDATE aegis.support_cases SET status = $1 WHERE id = $2', ['invalid', northId])))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('clears context after commit and rollback on the same pooled connection', async () => {
    for (const fixture of [north, south]) {
      await withTenantTransaction(single, fixture, async (client) => {
        expect((await client.query('SELECT id FROM aegis.tenants')).rows).toEqual([{ id: fixture.tenantId }]);
      });
      expect((await single.query('SELECT id FROM aegis.tenants')).rows).toEqual([]);
      await expect(withTenantTransaction(single, fixture, async () => { throw new Error('rollback requested'); }))
        .rejects.toThrow('rollback requested');
      expect((await single.query('SELECT id FROM aegis.tenants')).rows).toEqual([]);
    }
  });

  it('fails closed on malformed SQL tenant context and clears it after rollback', async () => {
    await expect(withTenantTransaction(single, north, async (client) => {
      await client.query("SELECT set_config('aegis.tenant_id', $1, true)", ['not-a-uuid']);
      await client.query('SELECT * FROM aegis.support_cases');
    })).rejects.toMatchObject({ code: '22P02' });
    expect((await single.query('SELECT * FROM aegis.tenants')).rows).toEqual([]);
    expect(await new CaseRepository(single, south, log).read(southId)).toMatchObject({ tenant_id: south.tenantId });
  });

  it('rolls back case creation, update and audit records together', async () => {
    let rolledBackId: string | undefined;
    const before = await a.audit(northId);
    const original = await a.read(northId);
    await expect(withTenantTransaction(pool, north, async (client) => {
      rolledBackId = (await client.query('INSERT INTO aegis.support_cases (tenant_id, synthetic_case_id) VALUES ($1, $2) RETURNING id',
        [north.tenantId, 'SYNTHETIC-LOGIN-001'])).rows[0].id;
      await client.query('UPDATE aegis.support_cases SET status = \'resolved\' WHERE id = $1', [northId]);
      throw new Error('rollback requested');
    })).rejects.toThrow('rollback requested');
    await expect(a.read(rolledBackId)).rejects.toMatchObject({ code: 'not_found' });
    expect(await a.audit(rolledBackId)).toEqual([]);
    expect(await a.audit(northId)).toEqual(before);
    expect((await a.read(northId)).status).toBe(original.status);
  });

  it('keeps concurrent transactions isolated across checked-out connections', async () => {
    await Promise.all(Array.from({ length: 12 }, (_, index) => {
      const fixture = index % 2 ? north : south;
      return withTenantTransaction(pool, fixture, async (client) => {
        await client.query('SELECT pg_sleep(0.01)');
        expect((await client.query('SELECT id FROM aegis.tenants')).rows).toEqual([{ id: fixture.tenantId }]);
        const result = await client.query('SELECT tenant_id FROM aegis.support_cases');
        expect(result.rows.every((row) => row.tenant_id === fixture.tenantId)).toBe(true);
      });
    }));
    expect((await pool.query('SELECT * FROM aegis.tenants')).rows).toEqual([]);
  });
});

describe('tenant-owned document and chunk storage', () => {
  const northPrincipal = documentPrincipal(documentNorthSubject);
  const southPrincipal = documentPrincipal(documentSouthSubject);

  it('allows a matching North and South membership to read only its own documents and chunks', async () => {
    const northRows = await withAuthenticatedTransaction(pool, northPrincipal, north.tenantId, 'read:cases', async (client) => ({
      documents: (await client.query('SELECT id, source_identity, version FROM aegis.documents ORDER BY id')).rows,
      chunks: (await client.query('SELECT id, document_id, document_version, source_identity, content FROM aegis.document_chunks ORDER BY id')).rows,
    }));
    expect(northRows.documents).toEqual([{ id: documents.north.id, source_identity: documents.north.sourceIdentity, version: 1 }]);
    expect(northRows.chunks).toEqual([{ id: chunks.north.id, document_id: documents.north.id, document_version: 1,
      source_identity: documents.north.sourceIdentity, content: northChunkContent }]);

    const southRows = await withAuthenticatedTransaction(pool, southPrincipal, south.tenantId, 'read:cases', async (client) => ({
      documents: (await client.query('SELECT id, source_identity, version FROM aegis.documents ORDER BY id')).rows,
      chunks: (await client.query('SELECT id, document_id, document_version, source_identity, content FROM aegis.document_chunks ORDER BY id')).rows,
    }));
    expect(southRows.documents).toEqual([{ id: documents.south.id, source_identity: documents.south.sourceIdentity, version: 2 }]);
    expect(southRows.chunks).toEqual([{ id: chunks.south.id, document_id: documents.south.id, document_version: 2,
      source_identity: documents.south.sourceIdentity, content: southChunkContent }]);
  });

  it('hides foreign document and chunk identifiers without disclosing content', async () => {
    await withAuthenticatedTransaction(pool, northPrincipal, north.tenantId, 'read:cases', async (client) => {
      expect((await client.query('SELECT id, source_identity FROM aegis.documents WHERE id = $1', [documents.south.id])).rows).toEqual([]);
      expect((await client.query('SELECT content FROM aegis.document_chunks WHERE id = $1', [chunks.south.id])).rows).toEqual([]);
    });
    await withAuthenticatedTransaction(pool, southPrincipal, south.tenantId, 'read:cases', async (client) => {
      expect((await client.query('SELECT id, source_identity FROM aegis.documents WHERE id = $1', [documents.north.id])).rows).toEqual([]);
      expect((await client.query('SELECT content FROM aegis.document_chunks WHERE id = $1', [chunks.north.id])).rows).toEqual([]);
    });
  });

  it('requires the authenticated mode, exact principal membership, and matching transaction-local tenant', async () => {
    for (const context of [
      { tenant: north.tenantId },
      { mode: 'authenticated', tenant: north.tenantId },
      { mode: 'authenticated', issuer: documentIssuer, subject: 'unknown-principal', tenant: north.tenantId },
      { mode: 'authenticated', issuer: 'https://wrong-issuer.example/', subject: documentNorthSubject, tenant: north.tenantId },
      { mode: 'authenticated', issuer: documentIssuer, subject: documentNorthSubject },
      { mode: 'authenticated', issuer: documentNorthSubject, subject: documentIssuer, tenant: north.tenantId },
    ]) {
      await rawDocumentContext(context, async (client) => {
        expect((await client.query('SELECT * FROM aegis.documents')).rows).toEqual([]);
        expect((await client.query('SELECT * FROM aegis.document_chunks')).rows).toEqual([]);
      });
    }
  });

  it('makes membership revocation effective for new snapshots while preserving an in-flight snapshot', async () => {
    try {
      await withAuthenticatedTransaction(pool, northPrincipal, north.tenantId, 'read:cases', async (client) => {
        await admin.query('DELETE FROM aegis.memberships WHERE issuer = $1 AND subject = $2',
          [documentIssuer, documentNorthSubject]);
        expect((await client.query('SELECT id FROM aegis.documents')).rows).toEqual([{ id: documents.north.id }]);
      });
      await expect(withAuthenticatedTransaction(pool, northPrincipal, north.tenantId, 'read:cases', async (client) =>
        client.query('SELECT id FROM aegis.documents'))).rejects.toMatchObject({ status: 403 });
    } finally {
      await admin.query(`INSERT INTO aegis.memberships (issuer, subject, tenant_id, role)
        VALUES ($1,$2,$3,'reader') ON CONFLICT (issuer,subject,tenant_id) DO UPDATE SET role = EXCLUDED.role`,
      [documentIssuer, documentNorthSubject, north.tenantId]);
    }
  });

  it('denies every runtime document and chunk mutation privilege', async () => {
    const denied = [
      { sql: 'INSERT INTO aegis.documents (tenant_id, source_identity, version, source_owner, ingestion_source, ingestion_revision, content_sha256) VALUES ($1,$2,1,$3,$4,$5,$6)',
        values: [north.tenantId, `${documentPrefix}-RUNTIME`, 'synthetic owner', 'source-controlled-synthetic-catalog', 'test', sha256('runtime')] },
      { sql: 'UPDATE aegis.documents SET metadata = \'{}\'::jsonb WHERE id = $1', values: [documents.north.id] },
      { sql: 'DELETE FROM aegis.documents WHERE id = $1', values: [documents.north.id] },
      { sql: 'TRUNCATE aegis.documents', values: [] },
      { sql: 'INSERT INTO aegis.document_chunks (tenant_id, document_id, document_version, source_identity, position, content, content_sha256) VALUES ($1,$2,1,$3,2,$4,$5)',
        values: [north.tenantId, documents.north.id, documents.north.sourceIdentity, 'synthetic new chunk', sha256('synthetic new chunk')] },
      { sql: 'UPDATE aegis.document_chunks SET content = $1 WHERE id = $2', values: ['synthetic update', chunks.north.id] },
      { sql: 'DELETE FROM aegis.document_chunks WHERE id = $1', values: [chunks.north.id] },
      { sql: 'TRUNCATE aegis.document_chunks', values: [] },
    ];
    for (const { sql, values } of denied) {
      await expect(pool.query(sql, values)).rejects.toMatchObject({ code: '42501' });
    }
    await expect(pool.query('SELECT * FROM aegis.documents')).resolves.toMatchObject({ rows: [] });
  });

  it('rejects cross-tenant, wrong-version, orphaned, mismatched-source and duplicate-position chunks', async () => {
    const insertChunk = (tenantId: string, documentId: string, version: number, sourceIdentity: string, position: number) =>
      admin.query(`INSERT INTO aegis.document_chunks
        (tenant_id, document_id, document_version, source_identity, position, content, content_sha256)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [tenantId, documentId, version, sourceIdentity, position, 'Synthetic constraint probe.', sha256('Synthetic constraint probe.')]);
    await expect(insertChunk(south.tenantId, documents.north.id, 1, documents.north.sourceIdentity, 10))
      .rejects.toMatchObject({ code: '23503' });
    await expect(insertChunk(north.tenantId, documents.north.id, 99, documents.north.sourceIdentity, 10))
      .rejects.toMatchObject({ code: '23503' });
    await expect(insertChunk(north.tenantId, randomUUID(), 1, documents.north.sourceIdentity, 10))
      .rejects.toMatchObject({ code: '23503' });
    await expect(insertChunk(north.tenantId, documents.north.id, 1, documents.south.sourceIdentity, 10))
      .rejects.toMatchObject({ code: '23503' });
    await expect(insertChunk(north.tenantId, documents.north.id, 1, documents.north.sourceIdentity, chunks.north.position))
      .rejects.toMatchObject({ code: '23505' });
    await expect(admin.query(`INSERT INTO aegis.document_chunks
      (tenant_id, document_id, document_version, source_identity, position, content, content_sha256)
      VALUES ($1,$2,1,$3,4,$4,$5)`,
    [north.tenantId, documents.north.id, documents.north.sourceIdentity, 'Mismatch hash.', sha256('not the stored chunk')]))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('enforces source identity, version, provenance, metadata, content and hash bounds', async () => {
    for (const invalid of [
      { sourceIdentity: 'arbitrary-customer-source', version: 1, sourceOwner: 'Owner', ingestionSource: 'source-controlled-synthetic-catalog', revision: 'test', metadata: '{}' },
      { sourceIdentity: `${documentPrefix}-BAD`, version: 0, sourceOwner: 'Owner', ingestionSource: 'source-controlled-synthetic-catalog', revision: 'test', metadata: '{}' },
      { sourceIdentity: `${documentPrefix}-BAD`, version: 1, sourceOwner: '', ingestionSource: 'source-controlled-synthetic-catalog', revision: 'test', metadata: '{}' },
      { sourceIdentity: `${documentPrefix}-BAD`, version: 1, sourceOwner: 'Owner', ingestionSource: 'other', revision: 'test', metadata: '{}' },
      { sourceIdentity: `${documentPrefix}-BAD`, version: 1, sourceOwner: 'Owner', ingestionSource: 'source-controlled-synthetic-catalog', revision: 'test', metadata: '[]' },
    ]) {
      await expect(admin.query(`INSERT INTO aegis.documents
        (tenant_id, source_identity, version, source_owner, ingestion_source, ingestion_revision, content_sha256, metadata)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [north.tenantId, invalid.sourceIdentity, invalid.version, invalid.sourceOwner, invalid.ingestionSource,
        invalid.revision, sha256('Synthetic metadata validation probe.'), invalid.metadata])).rejects.toMatchObject({ code: '23514' });
    }
    await expect(admin.query(`INSERT INTO aegis.documents
      (tenant_id, source_identity, version, source_owner, ingestion_source, ingestion_revision, content_sha256)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [north.tenantId, documents.north.sourceIdentity, documents.north.version, 'Aegis synthetic corpus',
      'source-controlled-synthetic-catalog', 'm4.1-test', documents.north.contentHash])).rejects.toMatchObject({ code: '23505' });
    for (const content of ['', 'x'.repeat(8193)]) {
      await expect(admin.query(`INSERT INTO aegis.document_chunks
        (tenant_id, document_id, document_version, source_identity, position, content, content_sha256)
        VALUES ($1,$2,1,$3,20,$4,$5)`,
      [north.tenantId, documents.north.id, documents.north.sourceIdentity, content, sha256(content)])).rejects.toMatchObject({ code: '23514' });
    }
    await expect(admin.query(`INSERT INTO aegis.documents
      (tenant_id, source_identity, version, source_owner, ingestion_source, ingestion_revision, content_sha256, metadata)
      VALUES ($1,$2,3,$3,$4,$5,$6,$7::jsonb)`,
    [north.tenantId, `${documentPrefix}-LARGE-METADATA`, 'Aegis synthetic corpus',
      'source-controlled-synthetic-catalog', 'm4.1-test', sha256('bounded metadata test'), JSON.stringify({ data: 'x'.repeat(5000) })]))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('rejects unsafe role grants and unexpected unprotected application tables', async () => {
    try {
      await admin.query('GRANT UPDATE (metadata) ON aegis.documents TO aegis_app');
      await expect(verifyRuntimeRole(pool)).rejects.toThrow('Unsafe application database role or schema.');
    } finally { await admin.query('REVOKE UPDATE (metadata) ON aegis.documents FROM aegis_app'); }
    await expect(verifyRuntimeRole(pool)).resolves.toBeUndefined();
    try {
      await admin.query('CREATE TABLE aegis.unexpected_unprotected_test (id integer)');
      await expect(verifyRuntimeRole(pool)).rejects.toThrow('Unsafe application database role or schema.');
    } finally { await admin.query('DROP TABLE IF EXISTS aegis.unexpected_unprotected_test'); }
    await expect(verifyRuntimeRole(pool)).resolves.toBeUndefined();
  });

  it('fails closed if either document table loses enabled or forced RLS', async () => {
    try {
      await admin.query('ALTER TABLE aegis.documents NO FORCE ROW LEVEL SECURITY');
      await expect(verifyRuntimeRole(pool)).rejects.toThrow('Unsafe application database role or schema.');
    } finally {
      await admin.query('ALTER TABLE aegis.documents FORCE ROW LEVEL SECURITY');
    }
    try {
      await admin.query('ALTER TABLE aegis.document_chunks DISABLE ROW LEVEL SECURITY');
      await expect(verifyRuntimeRole(pool)).rejects.toThrow('Unsafe application database role or schema.');
    } finally {
      await admin.query('ALTER TABLE aegis.document_chunks ENABLE ROW LEVEL SECURITY');
      await admin.query('ALTER TABLE aegis.document_chunks FORCE ROW LEVEL SECURITY');
    }
    await expect(verifyRuntimeRole(pool)).resolves.toBeUndefined();
  });

  it('clears transaction-local identity and tenant settings after commit and rollback on a reused connection', async () => {
    await withAuthenticatedTransaction(single, northPrincipal, north.tenantId, 'read:cases', async (client) => {
      expect((await client.query('SELECT id FROM aegis.documents')).rows).toEqual([{ id: documents.north.id }]);
    });
    expect((await single.query('SELECT id FROM aegis.documents')).rows).toEqual([]);
    await expect(withAuthenticatedTransaction(single, northPrincipal, north.tenantId, 'read:cases', async () => {
      throw new Error('synthetic rollback');
    })).rejects.toThrow('synthetic rollback');
    expect((await single.query('SELECT id FROM aegis.documents')).rows).toEqual([]);
  });

  it('isolates concurrent authenticated North and South document/chunk transactions', async () => {
    await Promise.all(Array.from({ length: 12 }, (_, index) => {
      const isNorth = index % 2 === 0;
      const tenant = isNorth ? north : south;
      const principal = isNorth ? northPrincipal : southPrincipal;
      const expectedDocument = isNorth ? documents.north.id : documents.south.id;
      const expectedChunk = isNorth ? chunks.north.id : chunks.south.id;
      return withAuthenticatedTransaction(pool, principal, tenant.tenantId, 'read:cases', async (client) => {
        await client.query('SELECT pg_sleep(0.01)');
        expect((await client.query('SELECT id FROM aegis.documents')).rows).toEqual([{ id: expectedDocument }]);
        expect((await client.query('SELECT id FROM aegis.document_chunks')).rows).toEqual([{ id: expectedChunk }]);
      });
    }));
  });
});
