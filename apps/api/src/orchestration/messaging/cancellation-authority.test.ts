import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { CANCELLATION_FUNCTIONS, CancellationAuthorityError, checkCancellationAuthority, verifyCancellationAuthority } from './cancellation-authority.js';

/*
 * Unit tests for the startup authority validator. A fake catalogue pool answers each query the validator issues, so each test can
 * present one unsupported configuration and assert that the named check fails. The PostgreSQL-backed negative tests (real grants,
 * triggers and roles) are in cancellation-authority.integration.test.ts.
 */

const OWNER = 'aegis_owner';
const SEARCH_PATH = 'search_path=pg_catalog, aegis';

interface Fixture {
  functions: Record<string, { prosecdef: boolean; proconfig: string[] | null; owner_reads_rows: boolean; owner: string } | undefined>;
  ownerSelects: boolean;
  ownerUpdates: boolean;
  ownerSchema: boolean;
  ownerRoleMap: boolean;
  identitySchema: boolean;
  identityRoleMap: boolean;
  acl: Record<string, string[]>;
  triggers: Record<string, { rel: string; proc: string; enabled: string; tgtype: number } | undefined>;
  memberships: number;
  canExecute: boolean;
  identity: { rolsuper: boolean; rolbypassrls: boolean; role_name: string | null };
}

/** pg_trigger.tgtype for a row-level BEFORE UPDATE trigger: ROW (1) | BEFORE (2) | UPDATE (16). */
const ROW_BEFORE_UPDATE = 19;

function healthy(): Fixture {
  const functions: Fixture['functions'] = {};
  const acl: Record<string, string[]> = {};
  for (const req of CANCELLATION_FUNCTIONS) {
    functions[req.proname] = { prosecdef: req.definerRights, proconfig: [SEARCH_PATH], owner_reads_rows: true, owner: OWNER };
    acl[req.proname] = [OWNER, ...req.executableBy];
  }
  return {
    functions,
    ownerSelects: true,
    acl,
    ownerUpdates: true,
    ownerSchema: true,
    ownerRoleMap: true,
    identitySchema: true,
    identityRoleMap: true,
    triggers: {
      agent_execution_record_cancellation_request: { rel: 'agent_executions', proc: 'record_cancellation_request', enabled: 'O', tgtype: ROW_BEFORE_UPDATE },
      agent_grant_refuse_consume_after_cancel: { rel: 'agent_grants', proc: 'refuse_request_consumption_after_cancel', enabled: 'O', tgtype: ROW_BEFORE_UPDATE },
    },
    memberships: 0,
    canExecute: true,
    identity: { rolsuper: false, rolbypassrls: false, role_name: 'orchestrator' },
  };
}

function fakePool(fixture: Fixture): Pool {
  const query = vi.fn(async (text: string, params: unknown[] = []) => {
    if (text.includes('owner.rolname AS owner')) {
      const fn = fixture.functions[params[0] as string];
      return { rows: fn ? [fn] : [] };
    }
    if (text.includes('map_ok')) return { rows: [{ schema_ok: fixture.identitySchema, map_ok: fixture.identityRoleMap }] };
    if (text.includes("has_table_privilege($1::regrole, 'aegis.agent_database_roles'")) return { rows: [{ ok: fixture.ownerRoleMap }] };
    if (text.includes("has_table_privilege($1::regrole, 'aegis.agent_executions'")) return { rows: [{ ok: fixture.ownerSelects }] };
    if (text.includes('has_schema_privilege($1::regrole')) return { rows: [{ ok: fixture.ownerSchema }] };
    if (text.includes('has_any_column_privilege')) return { rows: [{ ok: fixture.ownerUpdates }] };
    if (text.includes('aclexplode')) {
      const grantees = fixture.acl[params[0] as string] ?? [];
      return { rows: grantees.map((grantee) => ({ grantee, privilege: 'EXECUTE' })) };
    }
    if (text.includes('NOT t.tgisinternal')) {
      const t = fixture.triggers[params[0] as string];
      return { rows: t ? [t] : [] };
    }
    if (text.includes('pg_auth_members')) return { rows: [{ n: fixture.memberships }] };
    if (text.includes('has_function_privilege(session_user')) return { rows: [{ ok: fixture.canExecute }] };
    if (text.includes('LEFT JOIN aegis.agent_database_roles')) return { rows: [fixture.identity] };
    throw new Error(`unrouted catalogue query: ${text.slice(0, 60)}`);
  });
  return { query } as unknown as Pool;
}

async function failing(fixture: Fixture, identity = true): Promise<string[]> {
  return (await checkCancellationAuthority(fakePool(fixture), { identity })).filter((c) => !c.ok).map((c) => c.name);
}

describe('checkCancellationAuthority', () => {
  it('passes every check for the supported configuration', async () => {
    const checks = await checkCancellationAuthority(fakePool(healthy()), { identity: true });
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks.map((c) => c.name)).toEqual(expect.arrayContaining([
      'orchestrator_due_cancellations:present',
      'orchestrator_due_cancellations:owner_selects_executions',
      'orchestrator_due_cancellations:executable_by_aegis_orchestrator',
      'trigger:agent_execution_record_cancellation_request:enabled',
      'runtime_identity:not_superuser',
      'runtime_identity:can_execute:orchestrator_cancellation_backlog',
    ]));
  });

  it('reports a missing function by name and stops checking it', async () => {
    const f = healthy();
    f.functions.orchestrator_due_cancellations = undefined;
    expect(await failing(f)).toContain('orchestrator_due_cancellations:present');
  });

  it('rejects a function that is not SECURITY DEFINER', async () => {
    const f = healthy();
    f.functions.orchestrator_due_cancellations = { ...f.functions.orchestrator_due_cancellations!, prosecdef: false };
    expect(await failing(f)).toContain('orchestrator_due_cancellations:definer_rights');
  });

  it('rejects an unpinned search_path', async () => {
    const f = healthy();
    f.functions.refuse_request_consumption_after_cancel = { ...f.functions.refuse_request_consumption_after_cancel!, proconfig: null };
    expect(await failing(f)).toContain('refuse_request_consumption_after_cancel:search_path_pinned');
  });

  it('rejects an owner that cannot see rows, and an owner without the table privilege', async () => {
    const notBypass = healthy();
    notBypass.functions.orchestrator_due_cancellations = { ...notBypass.functions.orchestrator_due_cancellations!, owner_reads_rows: false };
    expect(await failing(notBypass)).toContain('orchestrator_due_cancellations:owner_reads_rows');

    const noSelect = healthy();
    noSelect.ownerSelects = false;
    expect(await failing(noSelect)).toEqual(expect.arrayContaining([
      'orchestrator_due_cancellations:owner_selects_executions',
      'orchestrator_cancellation_backlog:owner_selects_executions',
    ]));
  });

  it('rejects PUBLIC EXECUTE and an unexpected grantee', async () => {
    const pub = healthy();
    pub.acl.orchestrator_cancellation_backlog = [OWNER, 'aegis_orchestrator', 'PUBLIC'];
    expect(await failing(pub)).toEqual(expect.arrayContaining(['orchestrator_cancellation_backlog:no_public_execute']));

    const extra = healthy();
    extra.acl.orchestrator_due_cancellations = [OWNER, 'aegis_orchestrator', 'aegis_triage'];
    expect(await failing(extra)).toContain('orchestrator_due_cancellations:no_unexpected_execute');
  });

  it('requires the orchestrator role to hold EXECUTE on the discovery function', async () => {
    const f = healthy();
    f.acl.orchestrator_due_cancellations = [OWNER];
    expect(await failing(f)).toContain('orchestrator_due_cancellations:executable_by_aegis_orchestrator');
  });

  it('rejects a trigger that is attached to the wrong relation or function, or is disabled', async () => {
    const wrong = healthy();
    wrong.triggers.agent_execution_record_cancellation_request = { rel: 'agent_grants', proc: 'record_cancellation_request', enabled: 'O', tgtype: ROW_BEFORE_UPDATE };
    expect(await failing(wrong)).toContain('trigger:agent_execution_record_cancellation_request:attached');

    const disabled = healthy();
    disabled.triggers.agent_grant_refuse_consume_after_cancel = { rel: 'agent_grants', proc: 'refuse_request_consumption_after_cancel', enabled: 'D', tgtype: ROW_BEFORE_UPDATE };
    expect(await failing(disabled)).toContain('trigger:agent_grant_refuse_consume_after_cancel:enabled');

    const absent = healthy();
    absent.triggers.agent_grant_refuse_consume_after_cancel = undefined;
    expect(await failing(absent)).toContain('trigger:agent_grant_refuse_consume_after_cancel:present');
  });

  it('rejects a runtime identity that is superuser, BYPASSRLS, or not the orchestrator', async () => {
    const superuser = healthy();
    superuser.identity = { rolsuper: true, rolbypassrls: false, role_name: 'orchestrator' };
    expect(await failing(superuser)).toContain('runtime_identity:not_superuser');

    const bypass = healthy();
    bypass.identity = { rolsuper: false, rolbypassrls: true, role_name: 'orchestrator' };
    expect(await failing(bypass)).toContain('runtime_identity:not_bypassrls');

    const triage = healthy();
    triage.identity = { rolsuper: false, rolbypassrls: false, role_name: 'triage' };
    expect(await failing(triage)).toContain('runtime_identity:orchestrator_role');
  });

  it('rejects runtime role membership, and a runtime identity that cannot execute the functions', async () => {
    const member = healthy();
    member.memberships = 1;
    expect(await failing(member)).toContain('runtime_identity:no_role_membership');

    const cannot = healthy();
    cannot.canExecute = false;
    expect(await failing(cannot)).toEqual(expect.arrayContaining([
      'runtime_identity:can_execute:orchestrator_due_cancellations',
      'runtime_identity:can_execute:orchestrator_cancellation_backlog',
    ]));
  });

  it('rejects an owner without the UPDATE privilege that FOR UPDATE needs, and an owner without role-map access', async () => {
    const noLock = healthy();
    noLock.ownerUpdates = false;
    expect(await failing(noLock)).toContain('orchestrator_due_cancellations:owner_locks_executions');

    const noMap = healthy();
    noMap.ownerRoleMap = false;
    expect(await failing(noMap)).toEqual(expect.arrayContaining([
      'orchestrator_due_cancellations:owner_reads_role_map',
      'orchestrator_cancellation_backlog:owner_reads_role_map',
    ]));
  });

  it('rejects an owner without schema usage, and a runtime identity without schema or role-map access', async () => {
    const noSchema = healthy();
    noSchema.ownerSchema = false;
    expect(await failing(noSchema)).toContain('refuse_request_consumption_after_cancel:owner_schema_usage');

    const identity = healthy();
    identity.identitySchema = false;
    identity.identityRoleMap = false;
    expect(await failing(identity)).toEqual(expect.arrayContaining(['runtime_identity:schema_usage', 'runtime_identity:role_map_select']));
  });

  it('rejects a trigger whose event configuration is not a row-level BEFORE UPDATE trigger', async () => {
    const afterTrigger = healthy();
    afterTrigger.triggers.agent_execution_record_cancellation_request = { rel: 'agent_executions', proc: 'record_cancellation_request', enabled: 'O', tgtype: 17 };
    expect(await failing(afterTrigger)).toContain('trigger:agent_execution_record_cancellation_request:event_config');
  });

  it('omits identity checks when the caller does not supply an identity', async () => {
    const names = (await checkCancellationAuthority(fakePool(healthy()), { identity: false })).map((c) => c.name);
    expect(names.some((n) => n.startsWith('runtime_identity:'))).toBe(false);
  });
});

describe('verifyCancellationAuthority', () => {
  it('resolves for the supported configuration', async () => {
    await expect(verifyCancellationAuthority(fakePool(healthy()))).resolves.toBeUndefined();
  });

  it('throws an error listing every failed check name, and nothing else', async () => {
    const f = healthy();
    f.memberships = 2;
    f.triggers.agent_grant_refuse_consume_after_cancel = undefined;
    const error = await verifyCancellationAuthority(fakePool(f)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CancellationAuthorityError);
    const names = (error as CancellationAuthorityError).failed;
    expect(names).toEqual(expect.arrayContaining(['runtime_identity:no_role_membership', 'trigger:agent_grant_refuse_consume_after_cancel:present']));
    expect((error as Error).message).toBe(`cancellation authority validation failed: ${names.join(', ')}`);
  });

  it('defaults to validating the runtime identity', async () => {
    const f = healthy();
    f.identity = { rolsuper: true, rolbypassrls: false, role_name: 'orchestrator' };
    await expect(verifyCancellationAuthority(fakePool(f))).rejects.toBeInstanceOf(CancellationAuthorityError);
  });
});
