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
}

export const CANCELLATION_FUNCTIONS: readonly FunctionRequirement[] = [
  { proname: 'orchestrator_due_cancellations', signature: 'aegis.orchestrator_due_cancellations(integer)', definerRights: true,
    ownerReadsRows: true, executableBy: ['aegis_orchestrator'] },
  { proname: 'orchestrator_cancellation_backlog', signature: 'aegis.orchestrator_cancellation_backlog()', definerRights: true,
    ownerReadsRows: true, executableBy: ['aegis_orchestrator'] },
  { proname: 'refuse_request_consumption_after_cancel', signature: 'aegis.refuse_request_consumption_after_cancel()', definerRights: true,
    ownerReadsRows: true, executableBy: [] },
  { proname: 'record_cancellation_request', signature: 'aegis.record_cancellation_request()', definerRights: false,
    ownerReadsRows: false, executableBy: [] },
];

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
  if (options.identity) {
    const who = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean; role_name: string | null }>(
      `SELECT r.rolsuper, r.rolbypassrls, m.agent_id AS role_name
         FROM pg_roles r LEFT JOIN aegis.agent_database_roles m ON m.role_name = session_user
        WHERE r.rolname = session_user`, []);
    const me = who.rows[0];
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
