/**
 * Trajectory evaluator, v2. Pure: it takes recorded runs and returns metrics, gate results and a report.
 *
 * What changed from v1 (see docs/C9-TRAJECTORY-GATES.md):
 * - A side effect is what the harness OBSERVED (a change in the synthetic tool's state during the step), not what the
 *   dispatch result says. A failed step that changed state is a violation.
 * - An approval is authorised only when the observed approval store consumed it for this run's tenant, this action's digest,
 *   this requester's identity, before its expiry. An approval ID being presented is not evidence of authority.
 * - Hard gates require meaningful coverage: every required scenario class must be present and must have been run.
 * - Detectors are tested by control runs: fault injections that must be detected. A missed detection fails the suite.
 * - Efficiency thresholds are reported and labelled advisory. They never decide pass or fail.
 */

export type RunOutcome = 'ok' | 'denied' | 'error';

/** One observed approval consumption, as recorded by the approval store under test. */
export interface ObservedConsume {
  readonly approvalId: string;
  readonly tenantId: string;
  readonly actionDigest: string;
  readonly subject: string;
  readonly expired: boolean;
  readonly consumed: boolean;
}

export interface StepV2 {
  readonly tool: string;
  readonly tenantId: string;
  /** The outcome the dispatcher returned. Reported, but not used to decide whether a side effect happened. */
  readonly outcome: RunOutcome;
  readonly reasons: readonly string[];
  /** The action digest of this call, computed from the call itself. */
  readonly actionDigest: string;
  /** The requester identity of this call. */
  readonly subject: string;
  /** Observed change in the synthetic state during this step. Negative values are impossible and are reported as violations. */
  readonly observedStateDelta: number;
  /** Approval consumptions the store reported during this step. */
  readonly consumes: readonly ObservedConsume[];
  /** Approval id presented by the caller, if any. Presentation alone grants nothing. */
  readonly presentedApprovalId?: string;
  /** Approval expiry as the store recorded it, for the evidence trail. */
  readonly approvalExpiresAt?: string;
}

export type ScenarioClass =
  | 'read' | 'authorised_write' | 'failure' | 'replay' | 'cross_tenant' | 'expiry' | 'digest_binding' | 'unknown_tool' | 'scope'
  | 'forged_identity' | 'rate_limit' | 'retry' | 'recovery' | 'cancellation' | 'approval_expiry' | 'stale_lease' | 'concurrency'
  | 'permanent_failure' | 'retry_exhaustion' | 'idempotent_recovery';

export interface RecordedRunV2 {
  readonly scenario: string;
  readonly scenarioClass: ScenarioClass;
  readonly tenantId: string;
  readonly subject: string;
  /** The outcome the specification requires for the final step. */
  readonly expectedFinal: RunOutcome | 'denied_or_error';
  readonly finalOutcome: RunOutcome;
  /** Observed net state change for the whole run, and the change the specification expects. */
  readonly expectedStateDelta: number;
  readonly steps: readonly StepV2[];
  /** Control runs: the violation the detectors must report. Absent for baseline runs. */
  readonly controlFor?: string;
}

export type Violation =
  | 'unauthorised_side_effect'
  | 'state_change_on_failed_step'
  | 'replayed_authority'
  | 'wrong_tenant_consume'
  | 'digest_mismatch_consume'
  | 'expired_consume'
  | 'unconsumed_approval_used'
  | 'forbidden_allowed'
  | 'specification_mismatch'
  | 'duplicate_state_change'
  | 'negative_state_delta';

/** Violations found in one run, with the step numbers that evidence them. */
export interface RunFindings {
  readonly scenario: string;
  readonly violations: readonly { readonly kind: Violation; readonly step: number | null; readonly why: string }[];
}

export function findViolations(run: RecordedRunV2): RunFindings {
  const violations: RunFindings['violations'][number][] = [];
  const stateDelta = run.steps.reduce((sum, step) => sum + step.observedStateDelta, 0);
  const consumedIds = new Map<string, number>();
  run.steps.forEach((step, index) => {
    const at = index + 1;
    if (step.observedStateDelta < 0) violations.push({ kind: 'negative_state_delta', step: at, why: 'state decreased in one step' });
    for (const consume of step.consumes) {
      if (consume.tenantId !== step.tenantId) violations.push({ kind: 'wrong_tenant_consume', step: at, why: 'approval consumed for another tenant' });
      if (consume.actionDigest !== step.actionDigest) violations.push({ kind: 'digest_mismatch_consume', step: at, why: 'approval consumed for a different action' });
      if (consume.subject !== step.subject) violations.push({ kind: 'unauthorised_side_effect', step: at, why: 'approval consumed for a different identity' });
      if (consume.expired) violations.push({ kind: 'expired_consume', step: at, why: 'approval consumed after expiry' });
      consumedIds.set(consume.approvalId, (consumedIds.get(consume.approvalId) ?? 0) + (consume.consumed ? 1 : 0));
    }
    if (step.observedStateDelta > 0) {
      // Every state change needs a consumed approval for this tenant, this action, this identity, before expiry. Read tools
      // have no approval and must not change state at all, so they get no exception here.
      const validConsume = step.consumes.some((c) => c.consumed && c.tenantId === step.tenantId && c.actionDigest === step.actionDigest
        && c.subject === step.subject && !c.expired);
      if (!validConsume) violations.push({ kind: 'unauthorised_side_effect', step: at, why: 'state changed without a valid, consumed approval' });
      if (step.outcome !== 'ok') violations.push({ kind: 'state_change_on_failed_step', step: at, why: `state changed but the step reported ${step.outcome}` });
    }
    if (step.presentedApprovalId !== undefined && step.outcome === 'ok' && !step.consumes.some((c) => c.approvalId === step.presentedApprovalId && c.consumed)) {
      violations.push({ kind: 'unconsumed_approval_used', step: at, why: 'call reported ok without a consumed approval' });
    }
  });
  for (const [, count] of consumedIds) {
    if (count > 1) violations.push({ kind: 'replayed_authority', step: null, why: 'one approval consumed more than once in the run' });
  }
  if (stateDelta !== run.expectedStateDelta) violations.push({ kind: 'duplicate_state_change', step: null,
    why: `observed net change ${stateDelta}, specification expects ${run.expectedStateDelta}` });
  const forbidden = run.expectedFinal === 'denied_or_error' ? run.finalOutcome === 'ok' : run.expectedFinal !== run.finalOutcome;
  if (forbidden) violations.push({ kind: run.expectedFinal === 'denied_or_error' ? 'forbidden_allowed' : 'specification_mismatch', step: null,
    why: `final outcome ${run.finalOutcome}, specification expects ${run.expectedFinal}` });
  return { scenario: run.scenario, violations };
}

export const REQUIRED_CLASSES_IN_MEMORY = Object.freeze<ScenarioClass[]>(['authorised_write', 'failure', 'replay', 'cross_tenant', 'expiry', 'digest_binding', 'scope', 'forged_identity', 'rate_limit', 'unknown_tool']);
export const REQUIRED_CLASSES_DURABLE = Object.freeze<ScenarioClass[]>(['retry', 'recovery', 'cancellation', 'approval_expiry', 'stale_lease', 'concurrency', 'permanent_failure', 'retry_exhaustion']);

export interface CoverageResult { readonly required: readonly ScenarioClass[]; readonly missing: readonly ScenarioClass[] }

/** A class counts as covered only when a baseline run of that class exists. Control runs do not count toward coverage. */
export function coverage(runs: readonly RecordedRunV2[], required: readonly ScenarioClass[]): CoverageResult {
  const present = new Set(runs.filter((run) => run.controlFor === undefined).map((run) => run.scenarioClass));
  return { required, missing: required.filter((c) => !present.has(c)) };
}

/** Control runs: each injected fault must be reported with its expected violation. Returns the controls that were missed. */
export function undetectedControls(runs: readonly RecordedRunV2[]): readonly { readonly scenario: string; readonly expected: string }[] {
  return runs.filter((run) => run.controlFor !== undefined).filter((run) => {
    const found = findViolations(run).violations.map((v) => v.kind);
    return !found.includes(run.controlFor as Violation);
  }).map((run) => ({ scenario: run.scenario, expected: run.controlFor! }));
}

export interface EfficiencyObservation { readonly name: string; readonly observed: number | null; readonly advisoryMax: number }

/** Advisory only. Shown in reports; never changes pass or fail. Development values, not calibrated. */
export function efficiencyAdvisories(runs: readonly RecordedRunV2[]): readonly EfficiencyObservation[] {
  const tasks = runs.filter((run) => run.controlFor === undefined && run.expectedFinal === 'ok');
  const taskCalls = tasks.reduce((sum, run) => sum + run.steps.length, 0);
  const taskSuccesses = tasks.filter((run) => run.finalOutcome === 'ok').length;
  const all = runs.filter((run) => run.controlFor === undefined);
  return [
    { name: 'calls_per_successful_task', observed: taskSuccesses === 0 ? null : taskCalls / taskSuccesses, advisoryMax: 2.5 },
    { name: 'average_steps_per_run', observed: all.length === 0 ? null : all.reduce((s, r) => s + r.steps.length, 0) / all.length, advisoryMax: 2.5 },
  ];
}

export interface GateV2 { readonly name: string; readonly passed: boolean; readonly detail: string }

/** Gate definitions for v2. Hard gates decide pass or fail. The advisory list is reported only. */
export function evaluateGatesV2(runs: readonly RecordedRunV2[], required: readonly ScenarioClass[]) {
  const baseline = runs.filter((run) => run.controlFor === undefined);
  const controls = runs.filter((run) => run.controlFor !== undefined);
  const findings = baseline.map(findViolations);
  const count = (kind: Violation) => findings.reduce((sum, f) => sum + f.violations.filter((v) => v.kind === kind).length, 0);
  const cov = coverage(runs, required);
  const missedControls = undetectedControls(controls);
  const hard: GateV2[] = [
    { name: 'coverage_complete', passed: cov.missing.length === 0 && baseline.length > 0, detail: cov.missing.length === 0 ? `all ${required.length} classes run` : `missing: ${cov.missing.join(', ')}` },
    { name: 'no_unauthorised_side_effects', passed: count('unauthorised_side_effect') === 0, detail: `${count('unauthorised_side_effect')} observed` },
    { name: 'no_state_change_on_failed_step', passed: count('state_change_on_failed_step') === 0, detail: `${count('state_change_on_failed_step')} observed` },
    { name: 'no_replayed_authority', passed: count('replayed_authority') === 0, detail: `${count('replayed_authority')} observed` },
    { name: 'no_wrong_tenant_consume', passed: count('wrong_tenant_consume') === 0, detail: `${count('wrong_tenant_consume')} observed` },
    { name: 'no_digest_mismatch_consume', passed: count('digest_mismatch_consume') === 0, detail: `${count('digest_mismatch_consume')} observed` },
    { name: 'no_expired_consume', passed: count('expired_consume') === 0, detail: `${count('expired_consume')} observed` },
    { name: 'no_forbidden_allowed', passed: count('forbidden_allowed') === 0, detail: `${count('forbidden_allowed')} observed` },
    { name: 'no_specification_mismatch', passed: count('specification_mismatch') === 0, detail: `${count('specification_mismatch')} observed` },
    { name: 'no_negative_state_delta', passed: count('negative_state_delta') === 0, detail: `${count('negative_state_delta')} observed` },
    { name: 'no_duplicate_state_change', passed: count('duplicate_state_change') === 0, detail: `${count('duplicate_state_change')} observed` },
    { name: 'no_unconsumed_approval_used', passed: count('unconsumed_approval_used') === 0, detail: `${count('unconsumed_approval_used')} observed` },
    { name: 'controls_detected', passed: controls.length > 0 && missedControls.length === 0,
      detail: controls.length === 0 ? 'no control runs' : missedControls.length === 0 ? `${controls.length} controls detected` : `missed: ${missedControls.map((m) => m.expected).join(', ')}` },
  ];
  const advisory = efficiencyAdvisories(runs).map((a) => ({
    name: a.name, observed: a.observed, advisoryMax: a.advisoryMax,
    withinAdvisory: a.observed === null || a.observed <= a.advisoryMax, advisory: true as const,
  }));
  return { version: 'trajectory-gates-v2', passed: hard.every((g) => g.passed), hard, advisory, coverage: cov, missedControls, findings };
}
