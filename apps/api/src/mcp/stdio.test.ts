import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// Runs the real stdio entry point as a child process. Only refusal paths are tested here: a successful stdio session needs a token
// from a real identity provider (the production verifier requires an https JWKS), so it is demonstrated manually, not in CI.
const apiRoot = new URL('../../', import.meta.url);
const run = (env: Record<string, string>) => spawnSync(process.execPath, ['--import', 'tsx', 'src/mcp/stdio.ts'], {
  cwd: apiRoot, env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8', timeout: 30000,
});

const SECRET = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.c2VjcmV0LXNpZ25hdHVyZQ';

describe('stdio entry point refusals', () => {
  it('stays disabled unless AEGIS_MCP_ENABLED is 1, and writes nothing to stdout', () => {
    const result = run({});
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('disabled');
  }, 40000);

  it('refuses an invalid tenant before touching the database, and never echoes the credential', () => {
    const result = run({ AEGIS_MCP_ENABLED: '1', AEGIS_MCP_TENANT_ID: 'not-a-uuid', AEGIS_MCP_BEARER_TOKEN: SECRET });
    expect(result.status).toBe(3);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('AEGIS_MCP_TENANT_ID must be a UUID');
    expect(result.stderr).not.toContain(SECRET);
  }, 40000);

  it('refuses a malformed credential without echoing it', () => {
    const result = run({ AEGIS_MCP_ENABLED: '1', AEGIS_MCP_TENANT_ID: '11111111-1111-4111-8111-111111111111', AEGIS_MCP_BEARER_TOKEN: 'plainsecretvalue' });
    expect(result.status).toBe(3);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('plainsecretvalue');
  }, 40000);
});
