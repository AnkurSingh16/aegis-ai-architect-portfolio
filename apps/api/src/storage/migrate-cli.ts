import { localDatabaseUrl, requireDevelopment } from './config.js';
import { migrateDatabase } from './migrations.js';

try {
  requireDevelopment();
  const count = await migrateDatabase(localDatabaseUrl(process.env.DATABASE_ADMIN_URL), process.env.DATABASE_APP_PASSWORD ?? '');
  console.info(JSON.stringify({ event: 'database.migrated', applied: count }));
} catch {
  console.error(JSON.stringify({ event: 'database.migration_failed',
    message: 'Check local database configuration, role privileges and migration integrity. No database details are logged.' }));
  process.exitCode = 1;
}
