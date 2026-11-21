/**
 * Trajectory evaluator, v3. Pure. Builds on v2 (trajectory-evaluation-v2.ts, unchanged) with three rule changes. See
 * docs/C9-TRAJECTORY-GATES.md, section gates-v3.
 *
 * 1. Uncommitted outcome. A step whose driver call threw (for example, the connection was lost after the side effect committed
 *    and before the success was recorded) reports outcome 'uncertain'. A change observed in such a step is NOT a failed-step
 *    violation: the effect committed and the workflow outcome is unknown. It is still required to have a valid, consumed
 *    approval. Whether recovery was safe is judged by rule 2 and the duplicate rule, not by the crash itself.
 * 2. Duplicate business effect. Each durable run records what the business effect store observed, per logical operation. A
 *    logical operation that produced more than one effect is a duplicate, whatever the driver reported.
 * 3. Mandatory idempotent recovery. REQUIRED_CLASSES_DURABLE_V3 includes idempotent_recovery. Without that baseline run the
 *    coverage gate fails.
 */
import { coverage, findViolations as findViolationsV2, type RecordedRunV2, type RunOutcome, type ScenarioClass, type StepV2, type Violation, efficiencyAdvisories, REQUIRED_CLASSES_DURABLE } from './trajectory-evaluation-v2.js';

export type StepOutcomeV3 = RunOutcome | 'uncertain';

export interface StepV3 extends Omit<StepV2, 'outcome'> {
  readonly outcome: StepOutcomeV3;
}

/** Effects observed in the business effect store for one run, grouped by logical operation. */
export interface ObservedEffect { readonly operationKey: string; readonly rows: number }

export interface RecordedRunV3 extends Omit<RecordedRunV2, 'steps'> {
  readonly steps: readonly StepV3[];
  readonly observedEffects?: readonly ObservedEffect[];
}

export type ViolationV3 = Violation | 'duplicate_business_effect';

export interface RunFindingsV3 { readonly scenario: string; readonly violations: readonly { readonly kind: ViolationV3; readonly step: number | null; readonly why: string }[] }

export function findViolationsV3(run: RecordedRunV3): RunFindingsV3 {
  // Evaluate with v2 rules. An uncertain step is scored as an error for v2, then its failed-step violation is removed below.
  const asV2: RecordedRunV2 = { ...run, steps: run.steps.map((s) => ({ ...s, outcome: s.outcome === 'uncertain' ? 'error' : s.outcome }) as StepV2) };
  const uncertainSteps = new Set(run.steps.flatMap((s, i) => (s.outcome === 'uncertain' ? [i + 1] : [])));
  const violations: { kind: ViolationV3; step: number | null; why: string }[] = findViolationsV2(asV2).violations
    .filter((v) => !(v.kind === 'state_change_on_failed_step' && v.step !== null && uncertainSteps.has(v.step)));
  for (const effect of run.observedEffects ?? []) {
    if (effect.rows > 1) violations.push({ kind: 'duplicate_business_effect', step: null,
      why: `logical operation produced ${effect.rows} effects where one was specified` });
  }
  return { scenario: run.scenario, violations };
}

export const REQUIRED_CLASSES_DURABLE_V3 = Object.freeze<ScenarioClass[]>([...REQUIRED_CLASSES_DURABLE, 'idempotent_recovery']);

export interface GateV3 { readonly name: string; readonly passed: boolean; readonly detail: string }

export function evaluateGatesV3(runs: readonly RecordedRunV3[], required: readonly ScenarioClass[] = REQUIRED_CLASSES_DURABLE_V3) {
  const baseline = runs.filter((r) => r.controlFor === undefined);
  const controls = runs.filter((r) => r.controlFor !== undefined);
  const findings = baseline.map(findViolationsV3);
  const count = (kind: ViolationV3) => findings.reduce((sum, f) => sum + f.violations.filter((v) => v.kind === kind).length, 0);
  const cov = coverage(runs as unknown as RecordedRunV2[], required);
  const missed = controls.filter((run) => !findViolationsV3(run).violations.some((v) => v.kind === run.controlFor)).map((r) => ({ scenario: r.scenario, expected: r.controlFor! }));
  const hard: GateV3[] = [
    { name: 'coverage_complete', passed: cov.missing.length === 0 && baseline.length > 0, detail: cov.missing.length === 0 ? `all ${required.length} classes run` : `missing: ${cov.missing.join(', ')}` },
    { name: 'no_unauthorised_side_effects', passed: count('unauthorised_side_effect') === 0, detail: `${count('unauthorised_side_effect')} observed` },
    { name: 'no_state_change_on_failed_step', passed: count('state_change_on_failed_step') === 0, detail: `${count('state_change_on_failed_step')} observed` },
    { name: 'no_duplicate_business_effect', passed: count('duplicate_business_effect') === 0, detail: `${count('duplicate_business_effect')} observed` },
    { name: 'no_replayed_authority', passed: count('replayed_authority') === 0, detail: `${count('replayed_authority')} observed` },
    { name: 'no_wrong_tenant_consume', passed: count('wrong_tenant_consume') === 0, detail: `${count('wrong_tenant_consume')} observed` },
    { name: 'no_digest_mismatch_consume', passed: count('digest_mismatch_consume') === 0, detail: `${count('digest_mismatch_consume')} observed` },
    { name: 'no_expired_consume', passed: count('expired_consume') === 0, detail: `${count('expired_consume')} observed` },
    { name: 'no_forbidden_allowed', passed: count('forbidden_allowed') === 0, detail: `${count('forbidden_allowed')} observed` },
    { name: 'no_specification_mismatch', passed: count('specification_mismatch') === 0, detail: `${count('specification_mismatch')} observed` },
    { name: 'no_duplicate_state_change', passed: count('duplicate_state_change') === 0, detail: `${count('duplicate_state_change')} observed` },
    { name: 'no_unconsumed_approval_used', passed: count('unconsumed_approval_used') === 0, detail: `${count('unconsumed_approval_used')} observed` },
    { name: 'controls_detected', passed: controls.length > 0 && missed.length === 0,
      detail: controls.length === 0 ? 'no control runs' : missed.length === 0 ? `${controls.length} controls detected` : `missed: ${missed.map((m) => m.expected).join(', ')}` },
  ];
  const advisory = efficiencyAdvisories(runs as unknown as RecordedRunV2[]).map((a) => ({ ...a,
    withinAdvisory: a.observed === null || a.observed <= a.advisoryMax, advisory: true as const }));
  return { version: 'trajectory-gates-v3', passed: hard.every((g) => g.passed), hard, advisory, coverage: cov, missedControls: missed, findings };
}
