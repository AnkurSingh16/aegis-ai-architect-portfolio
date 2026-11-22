import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query, end } = vi.hoisted(() => ({
  query: vi.fn<(sql: string) => Promise<{ rows: unknown[] }>>(async () => ({ rows: [] })),
  end: vi.fn(async () => undefined),
}));
vi.mock('pg', () => ({
  Pool: class {
    query = query;
    end = end;
  },
}));

import { passwordVariable, provisionWorkloadRoles, WORKLOAD_ROLES } from './agent-roles-cli.js';

const PASSWORD = 'ci-isolated-orchestrator-role';
const ADMIN = 'postgres://aegis_ci_admin:admin-only-secret@127.0.0.1:5432/aegis_test';

describe('workload role provisioning', () => {
  beforeEach(() => {
    query.mockClear();
    end.mockClear();
  });

  it('maps each workload role to its own password variable', () => {
    expect(passwordVariable('aegis_orchestrator')).toBe('AGENT_ROLE_PASSWORD_ORCHESTRATOR');
    expect(passwordVariable('aegis_gateway')).toBe('AGENT_ROLE_PASSWORD_GATEWAY');
    expect(new Set(WORKLOAD_ROLES.map(passwordVariable)).size).toBe(WORKLOAD_ROLES.length);
  });

  it('gives login only to roles whose password variable is set, and no others', async () => {
    const provisioned = await provisionWorkloadRoles(ADMIN, { AGENT_ROLE_PASSWORD_ORCHESTRATOR: PASSWORD,
      AGENT_ROLE_PASSWORD_TRIAGE: 'ci-isolated-triage-role-only' });
    expect(provisioned).toEqual(['aegis_orchestrator', 'aegis_triage']);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0]).toBe(`ALTER ROLE aegis_orchestrator LOGIN NOINHERIT PASSWORD '${PASSWORD}'`);
    expect(query.mock.calls.map((call) => call[0]).join(' ')).not.toMatch(/aegis_(retrieval|reviewer|gateway|operator)/);
  });

  it('refuses a password that does not meet the policy before running any statement', async () => {
    for (const bad of ['short', 'has space in the middle of it 12', "quote'inside-the-password-x", 'x'.repeat(129)]) {
      await expect(provisionWorkloadRoles(ADMIN, { AGENT_ROLE_PASSWORD_REVIEWER: bad })).rejects.toThrow(RangeError);
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('closes the connection even when provisioning fails', async () => {
    query.mockRejectedValueOnce(new Error(`denied for ${ADMIN}`));
    await expect(provisionWorkloadRoles(ADMIN, { AGENT_ROLE_PASSWORD_ORCHESTRATOR: PASSWORD })).rejects.toThrow('denied');
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('returns role names only, never a credential', async () => {
    const provisioned = await provisionWorkloadRoles(ADMIN, { AGENT_ROLE_PASSWORD_GATEWAY: 'ci-isolated-gateway-role-only' });
    expect(JSON.stringify(provisioned)).not.toContain('ci-isolated');
  });
});
