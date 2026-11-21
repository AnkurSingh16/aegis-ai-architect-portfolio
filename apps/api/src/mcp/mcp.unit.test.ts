import { describe, expect, it } from 'vitest';
import { sanitiseDetail, subjectRef } from './audit.js';
import { MCP_CREDENTIAL_ENV, MCP_ENABLED_ENV, MCP_TENANT_ENV, mcpServerEnabled, parseMcpSettings } from './config.js';
import { caseTriageInput, documentsSearchInput, MCP_TOOL_SPECS, mcpToolDefinitions } from './tools.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'aaa.bbb.ccc';

describe('MCP configuration', () => {
  it('is disabled unless AEGIS_MCP_ENABLED is exactly "1"', () => {
    expect(mcpServerEnabled({})).toBe(false);
    expect(mcpServerEnabled({ [MCP_ENABLED_ENV]: 'true' })).toBe(false);
    expect(mcpServerEnabled({ [MCP_ENABLED_ENV]: '0' })).toBe(false);
    expect(mcpServerEnabled({ [MCP_ENABLED_ENV]: '1' })).toBe(true);
  });

  it('accepts a tenant UUID and a bearer-shaped credential', () => {
    expect(parseMcpSettings({ [MCP_TENANT_ENV]: TENANT, [MCP_CREDENTIAL_ENV]: TOKEN })).toEqual({ tenantId: TENANT, bearerToken: TOKEN });
  });

  it('rejects a missing or malformed tenant without echoing the value', () => {
    expect(() => parseMcpSettings({ [MCP_CREDENTIAL_ENV]: TOKEN })).toThrow(`${MCP_TENANT_ENV} must be a UUID`);
    expect(() => parseMcpSettings({ [MCP_TENANT_ENV]: 'not-a-uuid', [MCP_CREDENTIAL_ENV]: TOKEN }))
      .toThrowError(new RangeError(`${MCP_TENANT_ENV} must be a UUID`));
  });

  it('rejects a malformed credential and never includes it in the error', () => {
    const secret = 'plainsecretvalue';
    let message = '';
    try {
      parseMcpSettings({ [MCP_TENANT_ENV]: TENANT, [MCP_CREDENTIAL_ENV]: secret });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(`${MCP_CREDENTIAL_ENV} must be a bearer token`);
    expect(message).not.toContain(secret);
  });
});

describe('MCP audit', () => {
  it('stores a short digest of the subject, never the raw subject', () => {
    const ref = subjectRef('alice@example.test');
    expect(ref).toMatch(/^[0-9a-f]{12}$/);
    expect(ref).not.toContain('alice');
  });

  it('keeps only allowlisted, non-negative integer detail keys', () => {
    expect(sanitiseDetail({ queryLength: 7, resultCount: 2, query: 'secret text', extra: 1 })).toEqual({ queryLength: 7, resultCount: 2 });
    expect(sanitiseDetail({ queryLength: -1, resultCount: 1.5 })).toBeUndefined();
    expect(sanitiseDetail(undefined)).toBeUndefined();
  });
});

describe('MCP tool schemas', () => {
  it('rejects tenant, scope or any extra key in case.triage arguments', () => {
    expect(caseTriageInput.safeParse({ caseId: 'case-1', tenantId: TENANT }).success).toBe(false);
    expect(caseTriageInput.safeParse({ caseId: 'case-1', scopes: ['admin'] }).success).toBe(false);
  });

  it('rejects an unknown case identifier', () => {
    expect(caseTriageInput.safeParse({ caseId: 'no-such-case' }).success).toBe(false);
  });

  it('bounds the documents.search query and rejects extra keys', () => {
    expect(documentsSearchInput.safeParse({ query: '' }).success).toBe(false);
    expect(documentsSearchInput.safeParse({ query: 'x'.repeat(5000) }).success).toBe(false);
    expect(documentsSearchInput.safeParse({ query: 'refund policy', tenantId: TENANT }).success).toBe(false);
    expect(documentsSearchInput.safeParse({ query: 'refund policy' }).success).toBe(true);
  });

  it('declares only read-only tools with no approval requirement', () => {
    for (const definition of mcpToolDefinitions()) {
      expect(definition.sideEffect).toBe('read');
      expect(definition.requiresApproval).toBe(false);
    }
    expect(MCP_TOOL_SPECS.map((s) => s.name).sort()).toEqual(['case.triage', 'documents.search']);
  });
});

describe('MCP admission control', () => {
  const NOW = new Date('2026-11-21T00:00:00Z');

  it('refuses beyond the burst, then refuses again after the bucket is empty', async () => {
    const { createAdmissionController } = await import('./admission.js');
    const controller = createAdmissionController({ burst: 2, refillPerSecond: 0.000001, maxConcurrent: 10 });
    const first = controller.admit(NOW);
    const second = controller.admit(NOW);
    const third = controller.admit(NOW);
    expect(first.admitted && second.admitted).toBe(true);
    expect(third).toEqual({ admitted: false, reason: 'admission_throttled' });
  });

  it('refuses when the concurrency cap is reached, and admits again once a slot is released', async () => {
    const { createAdmissionController } = await import('./admission.js');
    const controller = createAdmissionController({ burst: 100, refillPerSecond: 100, maxConcurrent: 1 });
    const held = controller.admit(NOW);
    expect(held.admitted).toBe(true);
    expect(controller.admit(NOW)).toEqual({ admitted: false, reason: 'admission_saturated' });
    if (held.admitted) held.release();
    expect(controller.admit(NOW).admitted).toBe(true);
  });

  it('releases a slot only once, however often release is called', async () => {
    const { createAdmissionController } = await import('./admission.js');
    const controller = createAdmissionController({ burst: 100, refillPerSecond: 100, maxConcurrent: 2 });
    const held = controller.admit(NOW);
    if (!held.admitted) throw new Error('expected admission');
    held.release();
    held.release();
    expect(controller.inFlight()).toBe(0);
  });

  it('rejects invalid bounds', async () => {
    const { createAdmissionController } = await import('./admission.js');
    expect(() => createAdmissionController({ burst: 0, refillPerSecond: 1, maxConcurrent: 1 })).toThrow(RangeError);
    expect(() => createAdmissionController({ burst: 1, refillPerSecond: 0, maxConcurrent: 1 })).toThrow(RangeError);
    expect(() => createAdmissionController({ burst: 1, refillPerSecond: 1, maxConcurrent: 1.5 })).toThrow(RangeError);
  });
});
