import type { Pool } from 'pg';

/**
 * Fail-fast startup validation of the privileged cancellation functions and triggers (migrations 024 and 025). It reads the catalog and the
 * effective privileges through the connection it is given, which is the runtime identity in production. It refuses to start the
 * orchestrator when:
 * - a required function is missing;
 * - a SECURITY DEFINER function is not definer-rights, or its search_path is not pinned to pg_catalog, aegis;
 * - the owner cannot see rows (no superuser and no BYPASSRLS): the function would then return nothing and fail silently;
 * - PUBLIC, or any role other than the owner and the functions' intended callers, holds EXECUTE;
 * - the runtime identity is itself superuser or BYPASSRLS, or is not the orchestrator in the role table.
 * Failures name the check, never a catalog value, password or identifier.
 */

export interface AuthorityCheck { readonly name: string; readonly ok: boolean }

interface FunctionRequirement {
  readonly proname: string;
  readonly signature: string;
  readonly definerRights: boolean;
  /** Owner must see all rows (superuser or BYPASSRLS), because the function reads agent_executions across tenants. */
  readonly ownerReadsRows: boolean;
  /** Roles, other than the owner, that may hold EXECUTE. Empty for trigger functions. */
  readonly executableBy: readonly string[];
  /** The function locks rows with FOR UPDATE, which needs UPDATE privilege on the table for the owner. */
  readonly locksForUpdate?: boolean;
  /** The function reads aegis.agent_database_roles (the orchestrator-only check), which the owner must be able to SELECT. */
  readonly readsRoleMap?: boolean;
}

export const CANCELLATION_FUNCTIONS: readonly FunctionRequirement[] = [
  { proname: 'orchestrator_due_cancellations', signature: 'aegis.orchestrator_due_cancellations(integer)', definerRights: true,
    ownerReadsRows: true, executableBy: ['aegis_orchestrator'], locksForUpdate: true, readsRoleMap: true },
  { proname: 'orchestrator_cancellation_backlog', signature: 'aegis.orchestrator_cancellation_backlog()', definerRights: true,
    ownerReadsRows: true, executableBy: ['aegis_orchestrator'], readsRoleMap: true },
  { proname: 'refuse_request_consumption_after_cancel', signature: 'aegis.refuse_request_consumption_after_cancel()', definerRights: true,
    ownerReadsRows: true, executableBy: [] },
  { proname: 'record_cancellation_request', signature: 'aegis.record_cancellation_request()', definerRights: false,
    ownerReadsRows: false, executableBy: [] },
];

/** Every trigger must be a row-level BEFORE UPDATE trigger: an AFTER or statement-level trigger would not be able to refuse or stamp a row. */
export const CANCELLATION_TRIGGERS = [
  { name: 'agent_execution_record_cancellation_request', relation: 'agent_executions', proc: 'record_cancellation_request' },
  { name: 'agent_grant_refuse_consume_after_cancel', relation: 'agent_grants', proc: 'refuse_request_consumption_after_cancel' },
] as const;
const TG_ROW = 1, TG_BEFORE = 2, TG_UPDATE = 16;

const PINNED_SEARCH_PATH = 'search_path=pg_catalog, aegis';

export class CancellationAuthorityError extends Error {
  constructor(readonly failed: readonly string[]) {
    super(`cancellation authority validation failed: ${failed.join(', ')}`);
    this.name = 'CancellationAuthorityError';
  }
}

export async function checkCancellationAuthority(pool: Pool, options: { identity: boolean }): Promise<AuthorityCheck[]> {
  const checks: AuthorityCheck[] = [];
  const add = (name: string, ok: boolean) => checks.push({ name, ok });
  for (const req of CANCELLATION_FUNCTIONS) {
    const prefix = req.proname;
    const fn = await pool.query<{ prosecdef: boolean; proconfig: string[] | null; owner_reads_rows: boolean; owner: string }>(
      `SELECT p.prosecdef, p.proconfig, (owner.rolsuper OR owner.rolbypassrls) AS owner_reads_rows, owner.rolname AS owner
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_roles owner ON owner.oid = p.proowner
        WHERE n.nspname = 'aegis' AND p.proname = $1`, [req.proname]);
    const row = fn.rows[0];
    add(`${prefix}:present`, fn.rows.length === 1);
    if (!row) continue;
    add(`${prefix}:definer_rights`, row.prosecdef === req.definerRights);
    add(`${prefix}:search_path_pinned`, (row.proconfig ?? []).includes(PINNED_SEARCH_PATH));
    if (req.ownerReadsRows) add(`${prefix}:owner_reads_rows`, row.owner_reads_rows === true);
    if (req.ownerReadsRows) {
      // BYPASSRLS is not proof of access: the owner also needs the table privileges that the function's statements rely on.
      const priv = await pool.query<{ ok: boolean }>(
        `SELECT has_table_privilege($1::regrole, 'aegis.agent_executions', 'SELECT') AS ok`, [row.owner]);
      add(`${prefix}:owner_selects_executions`, priv.rows[0].ok === true);
      const schema = await pool.query<{ ok: boolean }>(`SELECT has_schema_privilege($1::regrole, 'aegis', 'USAGE') AS ok`, [row.owner]);
      add(`${prefix}:owner_schema_usage`, schema.rows[0].ok === true);
    }
    if (req.locksForUpdate) {
      // FOR UPDATE needs UPDATE on at least one column. The owner needs it for the discovery lock, not only SELECT.
      const upd = await pool.query<{ ok: boolean }>(
        `SELECT has_any_column_privilege($1::regrole, 'aegis.agent_executions', 'UPDATE') AS ok`, [row.owner]);
      add(`${prefix}:owner_locks_executions`, upd.rows[0].ok === true);
    }
    if (req.readsRoleMap) {
      const map = await pool.query<{ ok: boolean }>(
        `SELECT has_table_privilege($1::regrole, 'aegis.agent_database_roles', 'SELECT') AS ok`, [row.owner]);
      add(`${prefix}:owner_reads_role_map`, map.rows[0].ok === true);
    }
    const acl = await pool.query<{ grantee: string; privilege: string }>(
      `SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE g.rolname END AS grantee, a.privilege_type AS privilege
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
         LEFT JOIN pg_roles g ON g.oid = a.grantee
        WHERE n.nspname = 'aegis' AND p.proname = $1 AND a.privilege_type = 'EXECUTE'`, [req.proname]);
    const allowed = new Set([row.owner, ...req.executableBy]);
    const grantees = acl.rows.map((r) => r.grantee);
    add(`${prefix}:no_public_execute`, !grantees.includes('PUBLIC'));
    add(`${prefix}:no_unexpected_execute`, grantees.every((g) => allowed.has(g)));
    for (const role of req.executableBy) add(`${prefix}:executable_by_${role}`, grantees.includes(role));
  }
  for (const trigger of CANCELLATION_TRIGGERS) {
    // pg_trigger: attachment to the intended relation and function, and enabled for the session's replication role (tgenabled = 'O').
    const found = await pool.query<{ rel: string; proc: string; enabled: string; tgtype: number }>(
      `SELECT c.relname AS rel, p.proname AS proc, t.tgenabled::text AS enabled, t.tgtype::int AS tgtype
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE n.nspname = 'aegis' AND NOT t.tgisinternal AND t.tgname = $1`, [trigger.name]);
    const row = found.rows[0];
    add(`trigger:${trigger.name}:present`, found.rows.length === 1);
    add(`trigger:${trigger.name}:attached`, !!row && row.rel === trigger.relation && row.proc === trigger.proc);
    add(`trigger:${trigger.name}:enabled`, !!row && row.enabled === 'O');
    // Event configuration: row-level, BEFORE, UPDATE. Without this an AFTER trigger with the right name would pass the other checks.
    const want = TG_ROW | TG_BEFORE | TG_UPDATE;
    add(`trigger:${trigger.name}:event_config`, !!row && (row.tgtype & want) === want);
  }
  if (options.identity) {
    const membership = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = session_user`, []);
    add('runtime_identity:no_role_membership', membership.rows[0].n === 0);
    for (const fn of CANCELLATION_FUNCTIONS.filter((f) => f.executableBy.length > 0)) {
      const can = await pool.query<{ ok: boolean }>(`SELECT has_function_privilege(session_user, $1::regprocedure, 'EXECUTE') AS ok`, [fn.signature]);
      add(`runtime_identity:can_execute:${fn.proname}`, can.rows[0].ok === true);
    }
  }
  if (options.identity) {
    const who = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean; role_name: string | null }>(
      `SELECT r.rolsuper, r.rolbypassrls, m.agent_id AS role_name
         FROM pg_roles r LEFT JOIN aegis.agent_database_roles m ON m.role_name = session_user
        WHERE r.rolname = session_user`, []);
    const me = who.rows[0];
    const access = await pool.query<{ schema_ok: boolean; map_ok: boolean }>(
      `SELECT has_schema_privilege(session_user, 'aegis', 'USAGE') AS schema_ok,
              has_table_privilege(session_user, 'aegis.agent_database_roles', 'SELECT') AS map_ok`, []);
    add('runtime_identity:schema_usage', access.rows[0].schema_ok === true);
    add('runtime_identity:role_map_select', access.rows[0].map_ok === true);
    add('runtime_identity:not_superuser', me?.rolsuper === false);
    add('runtime_identity:not_bypassrls', me?.rolbypassrls === false);
    add('runtime_identity:orchestrator_role', me?.role_name === 'orchestrator');
  }
  return checks;
}

/** Throws CancellationAuthorityError naming every failed check. Called by the orchestrator before it accepts or reconciles work. */
export async function verifyCancellationAuthority(pool: Pool, options: { identity: boolean } = { identity: true }): Promise<void> {
  const checks = await checkCancellationAuthority(pool, options);
  const failed = checks.filter((c) => !c.ok).map((c) => c.name);
  if (failed.length > 0) throw new CancellationAuthorityError(failed);
}
