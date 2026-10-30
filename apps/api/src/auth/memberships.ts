import { Pool } from 'pg';
import { localDatabaseUrl, requireDevelopment, resolveFixture } from '../storage/config.js';
import { validateIssuer } from './config.js';

export type MembershipRole = 'reader' | 'operator';
export interface MembershipCommand {
  action: 'grant' | 'revoke'; issuer: string; subject: string; tenantId: string; role?: MembershipRole;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

export function parseMembershipCommand(args: string[], env: NodeJS.ProcessEnv): MembershipCommand {
  const action = args[0];
  if (args.length !== 1 || (action !== 'grant' && action !== 'revoke')) throw new Error('Choose grant or revoke.');
  const issuer = validateIssuer(env.AUTH0_ISSUER ?? '');
  const subject = env.AEGIS_MEMBER_SUBJECT;
  if (!subject || subject.length > 255 || subject.trim() !== subject || hasControlCharacter(subject)) {
    throw new Error('A verified synthetic Auth0 subject is required.');
  }
  const role = env.AEGIS_MEMBER_ROLE;
  if (action === 'grant' && role !== 'reader' && role !== 'operator') throw new Error('Choose reader or operator.');
  return { action, issuer, subject, tenantId: resolveFixture(env.AEGIS_MEMBER_FIXTURE).tenantId,
    ...(action === 'grant' ? { role: role as MembershipRole } : {}) };
}

/** Local administrator operation. The HTTP runtime has SELECT-only membership access. */
export async function provisionMembership(adminUrl: string, command: MembershipCommand): Promise<void> {
  requireDevelopment();
  const pool = new Pool({ connectionString: localDatabaseUrl(adminUrl), max: 1, connectionTimeoutMillis: 5000 });
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ allowed: boolean }>(`SELECT rolsuper AND current_user <> 'aegis_app' AS allowed
        FROM pg_roles WHERE rolname = current_user`);
      if (result.rows[0]?.allowed !== true) throw new Error('Administrator credentials are required.');
      if (command.action === 'grant') {
        await client.query(`INSERT INTO aegis.memberships (issuer, subject, tenant_id, role) VALUES ($1, $2, $3, $4)
          ON CONFLICT (issuer, subject, tenant_id) DO UPDATE SET role = EXCLUDED.role`,
        [command.issuer, command.subject, command.tenantId, command.role]);
      } else {
        await client.query('DELETE FROM aegis.memberships WHERE issuer = $1 AND subject = $2 AND tenant_id = $3',
          [command.issuer, command.subject, command.tenantId]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  } finally { await pool.end(); }
}
