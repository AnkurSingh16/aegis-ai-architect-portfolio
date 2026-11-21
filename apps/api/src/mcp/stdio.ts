import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { PoolClient } from 'pg';
import { resolveAuthConfig } from '../auth/config.js';
import { createTokenVerifier } from '../auth/token.js';
import { createDatabasePool, verifyRuntimeRole } from '../storage/database.js';
import { createPostgresApprovalStore, type TenantQueryable } from '../security/tool-approval-store.js';
import { createPostgresRateLimiter } from '../security/postgres-rate-limiter.js';
import { stderrAuditSink } from './audit.js';
import { mcpServerEnabled, parseMcpSettings } from './config.js';
import { createAegisMcpServer } from './server.js';

/**
 * Local MCP entry point, stdio transport. Standard output carries the protocol, so every diagnostic goes to standard error.
 * Exit codes: 2 disabled; 3 invalid configuration; 4 database role check failed; 5 credential rejected; 1 unexpected failure.
 */
function fail(code: number, message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

async function main(): Promise<void> {
  if (!mcpServerEnabled(process.env)) fail(2, 'The AEGIS MCP server is disabled. Set AEGIS_MCP_ENABLED=1 to run it locally.');
  let settings: ReturnType<typeof parseMcpSettings>;
  try {
    settings = parseMcpSettings(process.env);
  } catch (error) {
    fail(3, error instanceof Error ? error.message : 'Invalid MCP configuration.');
  }
  const authConfig = resolveAuthConfig(process.env);
  if (authConfig === undefined) fail(3, 'Authentication configuration is missing.');

  const pool = createDatabasePool(authConfig.databaseUrl, 4);
  try {
    await verifyRuntimeRole(pool);
  } catch {
    fail(4, 'The database role check failed.');
  }
  const verify = createTokenVerifier({ issuer: authConfig.issuer, audience: authConfig.audience });
  try {
    await verify(`Bearer ${settings.bearerToken}`);
  } catch {
    fail(5, 'The configured credential was not accepted.');
  }

  const runTenant = async <T>(tenantId: string, operation: (client: TenantQueryable) => Promise<T>): Promise<T> => {
    const client: PoolClient = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('aegis.tenant_id', $1, true)", [tenantId]);
      const result = await operation(client as unknown as TenantQueryable);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };

  const server = createAegisMcpServer({
    pool, bearerToken: settings.bearerToken, tenantId: settings.tenantId, verify,
    approvals: createPostgresApprovalStore(runTenant),
    limiter: createPostgresRateLimiter(runTenant, { capacity: 60, refillPerSecond: 20 }),
    audit: stderrAuditSink(),
  });
  await server.connect(new StdioServerTransport());
  process.stderr.write('AEGIS MCP server connected on stdio.\n');
}

main().catch(() => fail(1, 'The AEGIS MCP server stopped.'));
