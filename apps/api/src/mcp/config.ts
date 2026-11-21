/**
 * Local MCP configuration. The server is disabled unless AEGIS_MCP_ENABLED is exactly "1". Its tenant and its credential come from
 * the process environment that started it. Neither can be supplied by a model, by a tool argument or by a protocol message.
 */
export const MCP_ENABLED_ENV = 'AEGIS_MCP_ENABLED' as const;
export const MCP_TENANT_ENV = 'AEGIS_MCP_TENANT_ID' as const;
export const MCP_CREDENTIAL_ENV = 'AEGIS_MCP_BEARER_TOKEN' as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function mcpServerEnabled(env: NodeJS.ProcessEnv): boolean {
  return env[MCP_ENABLED_ENV] === '1';
}

export interface McpSettings {
  readonly tenantId: string;
  readonly bearerToken: string;
}

/** Validates the two settings the server needs. Errors name the setting, never its value. */
export function parseMcpSettings(env: NodeJS.ProcessEnv): McpSettings {
  const tenantId = env[MCP_TENANT_ENV];
  if (tenantId === undefined || !UUID.test(tenantId)) throw new RangeError(`${MCP_TENANT_ENV} must be a UUID`);
  const bearerToken = env[MCP_CREDENTIAL_ENV];
  if (bearerToken === undefined || bearerToken.length > 8192 || !JWT.test(bearerToken)) {
    throw new RangeError(`${MCP_CREDENTIAL_ENV} must be a bearer token`);
  }
  return { tenantId, bearerToken };
}
