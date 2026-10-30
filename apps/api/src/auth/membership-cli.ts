import { localDatabaseUrl, requireDevelopment } from '../storage/config.js';
import { parseMembershipCommand, provisionMembership } from './memberships.js';

try {
  requireDevelopment();
  const command = parseMembershipCommand(process.argv.slice(2), process.env);
  await provisionMembership(localDatabaseUrl(process.env.DATABASE_ADMIN_URL), command);
  console.info(JSON.stringify({ event: 'membership.changed', action: command.action }));
} catch {
  console.error(JSON.stringify({ event: 'membership.change_failed',
    message: 'Check local administrator configuration, verified synthetic subject and membership command.' }));
  process.exitCode = 1;
}
