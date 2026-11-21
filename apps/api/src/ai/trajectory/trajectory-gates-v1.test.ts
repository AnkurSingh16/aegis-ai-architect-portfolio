import { describe, expect, it } from 'vitest';
import { computeMetrics, evaluateGates, GATES_V1, type RecordedRun } from './trajectory-evaluation-v1.js';
import { runScenario, SCENARIOS } from './trajectory-harness-v1.js';

// C9 trajectory evaluation. Deterministic, mocked providers only: the real gateway and dispatcher run over synthetic tools.
// The first block runs the scenario set and gates it. The later blocks show that each gate actually fails on a breach.

const runs: RecordedRun[] = [];
for (const scenario of SCENARIOS) runs.push(await runScenario(scenario));
const metrics = computeMetrics(runs);
const report = evaluateGates(metrics);

describe('scenario set run through the real gateway', () => {
  it('covers the safety, tool-use, reliability and cost cases it claims to', () => {
    expect(SCENARIOS.map((s) => s.id)).toEqual(expect.arrayContaining([
      'write_without_approval', 'write_self_approval_refused', 'approval_replay_refused', 'approval_digest_mismatch',
      'cross_tenant_approval_refused', 'expired_approval_refused', 'failed_run_then_fresh_approval', 'external_without_approval',
      'unknown_tool', 'missing_write_scope', 'forged_context_refused', 'rate_limited_second_read', 'read_allowed', 'write_approved_once',
    ]));
  });

  it('matches the specification in every run', () => {
    const mismatched = runs.filter((run) => (run.expectedFinal === 'denied_or_error' ? run.finalOutcome === 'ok' : run.finalOutcome !== run.expectedFinal));
    expect(mismatched.map((run) => run.scenario)).toEqual([]);
    expect(metrics.specificationMatchRate).toBe(1);
  });

  it('passes every hard safety gate', () => {
    expect(report.hard.filter((g) => !g.passed)).toEqual([]);
  });

  it('observes the failed run as an error, never as success', () => {
    expect(metrics.failuresSurfaced).toBe(1);
  });

  it('passes the provisional soft gates for this set (cost proxies, not calibrated)', () => {
    expect(report.soft.filter((g) => !g.passed)).toEqual([]);
    expect(GATES_V1.version).toBe('trajectory-gates-v1');
  });

  it('shows that no side effect ran without an approved call', () => {
    expect(metrics.unapprovedSideEffects).toBe(0);
    expect(metrics.sideEffectsOnDeniedSteps).toBe(0);
  });
});

describe('each hard gate fails on a deliberate breach', () => {
  const base = (overrides: Partial<RecordedRun>): RecordedRun => ({
    scenario: 'x', expectedFinal: 'denied_or_error', finalOutcome: 'denied', tenantId: 'tenant-a', expectedSideEffects: 0,
    steps: [{ tool: 'synthetic.note.write', tenantId: 'tenant-a', outcome: 'denied', reasons: ['approval_required'], sideEffectCommitted: false }],
    ...overrides,
  });
  const failing = (breach: RecordedRun[]) => evaluateGates(computeMetrics(breach)).hard.filter((g) => !g.passed).map((g) => g.name);

  it('catches a side effect committed without any approval', () => {
    expect(failing([base({ expectedFinal: 'ok', finalOutcome: 'ok', expectedSideEffects: 1, steps: [
      { tool: 'synthetic.note.write', tenantId: 'tenant-a', outcome: 'ok', reasons: [], sideEffectCommitted: true },
    ] })])).toContain('no_unapproved_side_effects');
  });

  it('catches one approval used to commit two side effects', () => {
    const step = { tool: 'synthetic.note.write', tenantId: 'tenant-a', outcome: 'ok' as const, reasons: [], sideEffectCommitted: true, approvalId: 'apr-1', approvalTenantId: 'tenant-a' };
    expect(failing([base({ expectedFinal: 'ok', finalOutcome: 'ok', expectedSideEffects: 2, steps: [step, step] })])).toContain('no_replayed_authority');
  });

  it('catches an allowed step that used another tenant\'s approval', () => {
    expect(failing([base({ expectedFinal: 'ok', finalOutcome: 'ok', steps: [
      { tool: 'synthetic.note.write', tenantId: 'tenant-a', outcome: 'ok', reasons: [], sideEffectCommitted: true, approvalId: 'apr-2', approvalTenantId: 'tenant-b' },
    ], expectedSideEffects: 1 })])).toContain('no_wrong_tenant_access');
  });

  it('catches a forbidden run that was allowed', () => {
    expect(failing([base({ finalOutcome: 'ok', steps: [{ tool: 'case.read', tenantId: 'tenant-a', outcome: 'ok', reasons: [], sideEffectCommitted: false }] })]))
      .toContain('no_forbidden_allowed');
  });

  it('catches a denied step that still committed a side effect', () => {
    expect(failing([base({ steps: [{ tool: 'synthetic.note.write', tenantId: 'tenant-a', outcome: 'denied', reasons: ['approval_required'], sideEffectCommitted: true }] })]))
      .toContain('no_side_effects_on_denied_steps');
  });

  it('catches a handler failure reported as success', () => {
    expect(failing([base({ expectedFinal: 'ok', finalOutcome: 'ok', steps: [
      { tool: 'synthetic.note.write', tenantId: 'tenant-a', outcome: 'ok', reasons: ['handler_failed'], sideEffectCommitted: false },
    ] })])).toContain('failures_surfaced');
  });

  it('reports a soft-gate breach without failing the hard gates', () => {
    const many: RecordedRun = base({ expectedFinal: 'ok', finalOutcome: 'ok', steps: Array.from({ length: 6 }, () =>
      ({ tool: 'case.read', tenantId: 'tenant-a', outcome: 'ok' as const, reasons: [], sideEffectCommitted: false })) });
    const result = evaluateGates(computeMetrics([many]));
    expect(result.hard.every((g) => g.passed)).toBe(true);
    expect(result.soft.some((g) => !g.passed)).toBe(true);
    expect(result.passed).toBe(false);
  });
});
