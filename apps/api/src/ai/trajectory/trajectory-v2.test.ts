import { describe, expect, it } from 'vitest';
import { BASELINE_SCENARIOS_V2, CONTROL_SCENARIOS_V2, runScenarioV2 } from './trajectory-harness-v2.js';
import { evaluateGatesV2, findViolations, REQUIRED_CLASSES_IN_MEMORY, type RecordedRunV2 } from './trajectory-evaluation-v2.js';
import { buildReportV2 } from './trajectory-report-v2.js';

// C9 v2 evaluation, in memory. Baseline runs must be clean and cover every required class. Control runs inject faulty execution
// paths; the evaluator must detect each one. The gates are tested against deliberate misses, not only against clean output.

const baseline: RecordedRunV2[] = [];
const controls: RecordedRunV2[] = [];
for (const s of BASELINE_SCENARIOS_V2) baseline.push(await runScenarioV2(s));
for (const s of CONTROL_SCENARIOS_V2) controls.push(await runScenarioV2(s));
const all = [...baseline, ...controls];

describe('baseline runs through the real gateway, observed rather than assumed', () => {
  it('produces no violation in any baseline run', () => {
    expect(baseline.flatMap((r) => findViolations(r).violations)).toEqual([]);
  });

  it('matches the specification in every baseline run', () => {
    for (const run of baseline) {
      const ok = run.expectedFinal === 'denied_or_error' ? run.finalOutcome !== 'ok' : run.finalOutcome === run.expectedFinal;
      expect(ok, run.scenario).toBe(true);
    }
  });

  it('observes each approved write change exactly once, under a consumed approval', () => {
    const approved = baseline.find((r) => r.scenario === 'write_approved_once')!;
    expect(approved.steps.map((s) => s.observedStateDelta)).toEqual([1]);
    expect(approved.steps[0]!.consumes.map((c) => c.consumed)).toEqual([true]);
  });

  it('passes every hard gate once the required coverage is present', () => {
    const gates = evaluateGatesV2(all, REQUIRED_CLASSES_IN_MEMORY);
    expect(gates.hard.filter((g) => !g.passed)).toEqual([]);
    expect(gates.passed).toBe(true);
  });
});

describe('each injected fault is detected by the evaluator', () => {
  it('detects every control with the violation it was designed to produce', () => {
    for (const run of controls) {
      const kinds = findViolations(run).violations.map((v) => v.kind);
      expect(kinds, run.scenario).toContain(run.controlFor);
    }
  });

  it('reports a control as missed when its violation disappears (the gate would fail)', () => {
    // Remove the evidence a detector relies on, then check that the control is reported as missed.
    const stripped: RecordedRunV2[] = controls.map((r) => r.scenario === 'control_gateway_skips_approval'
      ? { ...r, steps: r.steps.map((s) => ({ ...s, observedStateDelta: 0 })), finalOutcome: 'denied' as const } : r);
    const gates = evaluateGatesV2([...baseline, ...stripped], REQUIRED_CLASSES_IN_MEMORY);
    expect(gates.missedControls.map((m) => m.scenario)).toContain('control_gateway_skips_approval');
    expect(gates.hard.find((g) => g.name === 'controls_detected')!.passed).toBe(false);
    expect(gates.passed).toBe(false);
  });
});

describe('coverage is required, not assumed', () => {
  it('fails the hard gate when a required class has no baseline run', () => {
    const withoutReplay = baseline.filter((r) => r.scenarioClass !== 'replay');
    const gates = evaluateGatesV2([...withoutReplay, ...controls], REQUIRED_CLASSES_IN_MEMORY);
    expect(gates.coverage.missing).toContain('replay');
    expect(gates.hard.find((g) => g.name === 'coverage_complete')!.passed).toBe(false);
    expect(gates.passed).toBe(false);
  });

  it('does not count a control run toward coverage', () => {
    const onlyControls = controls;
    const gates = evaluateGatesV2(onlyControls, REQUIRED_CLASSES_IN_MEMORY);
    expect(gates.coverage.missing.length).toBe(REQUIRED_CLASSES_IN_MEMORY.length);
    expect(gates.passed).toBe(false);
  });

  it('fails when no baseline run exists at all, even if the controls pass', () => {
    expect(evaluateGatesV2(controls, REQUIRED_CLASSES_IN_MEMORY).passed).toBe(false);
  });
});

describe('efficiency is advisory and visible', () => {
  it('shows the provisional thresholds but does not let them decide pass or fail', () => {
    const gates = evaluateGatesV2(all, REQUIRED_CLASSES_IN_MEMORY);
    expect(gates.advisory.length).toBeGreaterThan(0);
    expect(gates.advisory.every((a) => a.advisory === true)).toBe(true);
    // Make an advisory threshold fail on purpose: the verdict must not change.
    // Extra read-only steps raise the cost measure without changing any state, so only the advisory should move.
    const readStep = { tool: 'case.read', tenantId: 'tenant-a', outcome: 'ok' as const, reasons: [], subject: 'requester-1',
      actionDigest: 'advisory', observedStateDelta: 0, consumes: [] };
    const heavy: RecordedRunV2[] = baseline.map((r) => ({ ...r, steps: [...r.steps, ...Array.from({ length: 12 }, () => readStep)] }));
    const heavyGates = evaluateGatesV2([...heavy, ...controls], REQUIRED_CLASSES_IN_MEMORY);
    expect(heavyGates.advisory.some((a) => !a.withinAdvisory)).toBe(true);
    expect(heavyGates.hard.every((g) => g.passed)).toBe(true);
  });
});

describe('the evidence report', () => {
  const report = buildReportV2(all, REQUIRED_CLASSES_IN_MEMORY);
  const json = JSON.stringify(report);

  it('explains each decision by step, with the observed change and the approval facts', () => {
    const run = report.runs.find((r) => r.scenario === 'write_approved_once')!;
    expect(run.steps[0]!.decision).toBe('state_changed_under_valid_approval');
    expect(run.steps[0]!.consumes[0]).toMatchObject({ consumed: true, expired: false, digestMatches: true });
    expect(run.finalMatchesSpecification).toBe(true);
  });

  it('records whether each control was detected', () => {
    const controlRuns = report.runs.filter((r) => r.kind === 'control');
    expect(controlRuns.every((r) => r.controlDetected === true)).toBe(true);
  });

  it('does not expose raw identifiers, approval ids, notes or subjects', () => {
    expect(json).not.toContain('requester-1');
    expect(json).not.toContain('reviewer-2');
    expect(json).not.toContain('synthetic note');
    expect(json).not.toContain('00000000-0000-4000-8000');
    expect(json).not.toContain('tenant-a');
  });
});
