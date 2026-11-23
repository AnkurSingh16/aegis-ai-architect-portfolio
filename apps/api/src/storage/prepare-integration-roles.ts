import { provisionWorkloadRoles } from './agent-roles-cli.js';
import { localDatabaseUrl, requireDevelopment } from './config.js';
import { migrateDatabase } from './migrations.js';

/**
 * Test-database preparation for the PostgreSQL integration suite. Development and CI only, on the disposable aegis_test database.
 *
 * It applies the migrations (idempotent), then gives each workload role its login credential from AGENT_ROLE_PASSWORD_* variables.
 * Migrations create the workload roles without login, so provisioning must run after migrating. Only role names are printed.
 */
async function main(): Promise<void> {
  requireDevelopment();
  const adminUrl = localDatabaseUrl(process.env.TEST_DATABASE_ADMIN_URL);
  if (new URL(adminUrl).pathname !== '/aegis_test') throw new Error('Integration preparation only targets aegis_test.');
  const migrations = await migrateDatabase(adminUrl, process.env.DATABASE_APP_PASSWORD ?? '', process.env.DATABASE_INGEST_PASSWORD ?? '');
  const roles = await provisionWorkloadRoles(adminUrl, process.env);
  process.stdout.write(`${JSON.stringify({ event: 'integration_roles.prepared', migrationsApplied: migrations, roles })}\n`);
}

main().catch(() => {
  process.stderr.write(`${JSON.stringify({ event: 'integration_roles.failed' })}\n`);
  process.exitCode = 1;
});
