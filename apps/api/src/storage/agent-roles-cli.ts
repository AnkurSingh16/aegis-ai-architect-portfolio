import { Pool } from 'pg';

/**
 * Administrator tool. Gives each workload role its login credential. Migrations create the roles without login (NOLOGIN); this tool
 * is the only place a password is set for them, so credentials are never written into migrations or the repository.
 *
 * Usage: DATABASE_ADMIN_URL=... AGENT_ROLE_PASSWORD_ORCHESTRATOR=... node dist/storage/agent-roles-cli.js
 * Only roles whose password variable is set are provisioned. A password must be 24 to 128 characters of [A-Za-z0-9._~-].
 */
export const WORKLOAD_ROLES = ['aegis_orchestrator', 'aegis_triage', 'aegis_retrieval', 'aegis_reviewer', 'aegis_gateway', 'aegis_operator'] as const;
export type WorkloadRole = (typeof WORKLOAD_ROLES)[number];

export function passwordVariable(role: WorkloadRole): string {
  return `AGENT_ROLE_PASSWORD_${role.replace(/^aegis_/, '').toUpperCase()}`;
}

export async function provisionWorkloadRoles(adminUrl: string, env: NodeJS.ProcessEnv): Promise<WorkloadRole[]> {
  const pool = new Pool({ connectionString: adminUrl, max: 1 });
  const provisioned: WorkloadRole[] = [];
  try {
    for (const role of WORKLOAD_ROLES) {
      const password = env[passwordVariable(role)];
      if (!password) continue;
      if (!/^[A-Za-z0-9._~-]{24,128}$/.test(password)) throw new RangeError(`${passwordVariable(role)} does not meet the password policy`);
      // Role names are constants from WORKLOAD_ROLES, so they are safe to quote as identifiers. The password is validated above.
      await pool.query(`ALTER ROLE ${role} LOGIN NOINHERIT PASSWORD '${password}'`);
      provisioned.push(role);
    }
  } finally {
    await pool.end();
  }
  return provisioned;
}

if (process.argv[1]?.endsWith('agent-roles-cli.js') || process.argv[1]?.endsWith('agent-roles-cli.ts')) {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!adminUrl) throw new Error('DATABASE_ADMIN_URL is required');
  provisionWorkloadRoles(adminUrl, process.env)
    .then((roles) => process.stdout.write(`${JSON.stringify({ event: 'agent_roles.provisioned', roles })}\n`))
    .catch((error: unknown) => {
      process.stderr.write(`${JSON.stringify({ event: 'agent_roles.failed', error: error instanceof Error ? error.message : 'error' })}\n`);
      process.exitCode = 1;
    });
}
