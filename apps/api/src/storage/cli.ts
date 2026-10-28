import { CaseRepository, CaseStorageError } from './cases.js';
import { parseCaseCommand, executeCaseCommand } from './commands.js';
import { localDatabaseUrl, requireDevelopment, resolveFixture } from './config.js';
import { createDatabasePool, verifyRuntimeRole } from './database.js';

try {
  requireDevelopment();
  const command = parseCaseCommand(process.argv.slice(2));
  const fixture = resolveFixture(process.env.AEGIS_DEV_FIXTURE);
  const pool = createDatabasePool(localDatabaseUrl(process.env.DATABASE_URL));
  try {
    await verifyRuntimeRole(pool);
    const result = await executeCaseCommand(new CaseRepository(pool, fixture), command);
    console.info(JSON.stringify({ mode: 'synthetic-persistent-local', fixture: fixture.name, result }, null, 2));
  } finally { await pool.end(); }
} catch (error) {
  console.error(JSON.stringify({ event: 'case_command.failed',
    code: error instanceof CaseStorageError ? error.code : 'configuration_or_database_error',
    message: error instanceof CaseStorageError ? error.message : 'Check local database configuration and runtime role. No database details are logged.' }));
  process.exitCode = 1;
}
