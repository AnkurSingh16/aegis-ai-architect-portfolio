import { describe, expect, it } from 'vitest';
import { evaluateGatesV3, findViolationsV3, REQUIRED_CLASSES_DURABLE_V3, type RecordedRunV3, type StepV3 } from './trajectory-evaluation-v3.js';

// Deterministic v3 rules, on hand-built observations. The end-to-end evidence is in durable-trajectories.integration.test.ts.
const consume = { approvalId: 'apr-1', tenantId: 'tenant-a', actionDigest: 'd1', subject: 'operator-1', expired: false, consumed: true };
const write = (outcome: StepV3['outcome'], delta: number, consumes = [consume]): StepV3 => ({
  tool: 'synthetic.note.write', tenantId: 'tenant-a', outcome, reasons: outcome === 'uncertain' ? ['connection_lost_after_commit'] : [],
  subject: 'operator-1', actionDigest: 'd1', observedStateDelta: delta, consumes,
});
const run = (over: Partial<RecordedRunV3>): RecordedRunV3 => ({
  scenario: 'x', scenarioClass: 'idempotent_recovery', tenantId: 'tenant-a', subject: 'operator-1', expectedFinal: 'ok', finalOutcome: 'ok',
  expectedStateDelta: 1, steps: [write('uncertain', 1), write('ok', 0, [])], ...over,
});

describe('gates-v3 rules', () => {
  it('an uncommitted outcome after a committed, authorised change is not a failed-step violation', () => {
    expect(findViolationsV3(run({})).violations).toEqual([]);
  });

  it('an uncommitted outcome with a change and no valid approval is still an unauthorised side effect', () => {
    const kinds = findViolationsV3(run({ steps: [write('uncertain', 1, []), write('ok', 0, [])] })).violations.map((v) => v.kind);
    expect(kinds).toContain('unauthorised_side_effect');
  });

  it('a plain failed step that changed state is still a failed-step violation (not excused as uncertain)', () => {
    const kinds = findViolationsV3(run({ finalOutcome: 'error', expectedFinal: 'denied_or_error', expectedStateDelta: 1,
      steps: [write('error', 1)] })).violations.map((v) => v.kind);
    expect(kinds).toContain('state_change_on_failed_step');
  });

  it('observed duplicate business effects are detected whatever the driver reported', () => {
    const kinds = findViolationsV3(run({ observedEffects: [{ operationKey: 'notify:e1', rows: 2 }] })).violations.map((v) => v.kind);
    expect(kinds).toContain('duplicate_business_effect');
  });

  it('a single observed effect per logical operation is not a duplicate', () => {
    expect(findViolationsV3(run({ observedEffects: [{ operationKey: 'notify:e1', rows: 1 }] })).violations).toEqual([]);
  });

  it('idempotent_recovery is mandatory: the gate fails when that baseline run is absent', () => {
    expect(REQUIRED_CLASSES_DURABLE_V3).toContain('idempotent_recovery');
    const gates = evaluateGatesV3([run({ scenarioClass: 'retry' })]);
    expect(gates.coverage.missing).toContain('idempotent_recovery');
    expect(gates.passed).toBe(false);
  });

  it('a control that expects duplicate_business_effect fails the gate if the detector stops firing', () => {
    const control = run({ scenario: 'control', controlFor: 'duplicate_business_effect', observedEffects: [{ operationKey: 'notify:e1', rows: 1 }] });
    const gates = evaluateGatesV3([run({}), control], ['idempotent_recovery']);
    expect(gates.missedControls.map((m) => m.scenario)).toContain('control');
    expect(gates.hard.find((g) => g.name === 'controls_detected')!.passed).toBe(false);
  });
});
