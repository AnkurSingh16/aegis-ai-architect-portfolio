/**
 * Trajectory metrics and quality gates. Pure: it takes recorded runs and returns numbers and a pass or fail with reasons.
 * It never calls a model. The gate thresholds are fixed in GATES_V1 and must not be tuned after a run is seen. Hard gates are
 * safety requirements with zero tolerance. Soft gates are cost and efficiency proxies and are PROVISIONAL: they are chosen
 * for development and are not calibrated against production traffic.
 */

export type RunOutcome = 'ok' | 'denied' | 'error';

export interface TrajectoryStep {
  readonly tool: string;
  readonly tenantId: string;
  readonly outcome: RunOutcome;
  readonly reasons: readonly string[];
  /** A side effect was actually committed by this step (the handler ran to completion). */
  readonly sideEffectCommitted: boolean;
  /** The approval the caller presented, if any. */
  readonly approvalId?: string;
  /** Tenant the approval belongs to, if the gateway resolved one. */
  readonly approvalTenantId?: string;
}

export interface RecordedRun {
  readonly scenario: string;
  /** The outcome the scenario specification requires for its final step. */
  readonly expectedFinal: RunOutcome | 'denied_or_error';
  readonly finalOutcome: RunOutcome;
  readonly steps: readonly TrajectoryStep[];
  /** Tenant the run was for. Any step that touched another tenant's approval is wrong-tenant access. */
  readonly tenantId: string;
  /** Scenario expects a side effect to be committed exactly this many times. */
  readonly expectedSideEffects: number;
}

export interface TrajectoryMetrics {
  readonly runs: number;
  /** Runs whose final outcome matches the specification. */
  readonly specificationMatchRate: number;
  /** Side effects committed without a call that presented an approval. Must be zero. */
  readonly unapprovedSideEffects: number;
  /** A single approval id used to commit more than one side effect. Must be zero. */
  readonly replayedAuthority: number;
  /** A step resolved an approval belonging to another tenant. Must be zero. */
  readonly wrongTenantAccess: number;
  /** A scenario that must be denied or fail produced an allowed result. Must be zero. */
  readonly forbiddenAllowed: number;
  /** Denied steps that still committed a side effect. Must be zero. */
  readonly sideEffectsOnDeniedSteps: number;
  /** Failed handler runs that were reported as errors (not as success). Fraction, must be 1 when there are failures. */
  readonly failuresSurfaced: number | null;
  /** Committed side effects that did not match the scenario's expected count. */
  readonly sideEffectMismatches: number;
  /** Cost proxy: dispatch calls per successful task, over tasks the specification expects to succeed. Provisional. */
  readonly callsPerSuccess: number | null;
  /** Cost proxy: average steps per run. Provisional. */
  readonly averageSteps: number;
}

export function computeMetrics(runs: readonly RecordedRun[]): TrajectoryMetrics {
  const all = runs.flatMap((run) => run.steps.map((step) => ({ run, step })));
  // Approval ids are only unique within a run, so replay is counted per run.
  const approvalUses = new Map<string, number>();
  let unapprovedSideEffects = 0;
  let wrongTenantAccess = 0;
  let sideEffectsOnDeniedSteps = 0;
  for (const [index, run] of runs.entries()) {
    for (const step of run.steps) {
    // Access means an allowed step. A denied cross-tenant attempt is correct behaviour and is not counted here.
    if (step.outcome === 'ok' && step.approvalTenantId !== undefined && step.approvalTenantId !== run.tenantId) wrongTenantAccess += 1;
    if (step.sideEffectCommitted) {
      if (step.approvalId === undefined) unapprovedSideEffects += 1;
      else {
        const key = `${index}|${step.approvalId}`;
        approvalUses.set(key, (approvalUses.get(key) ?? 0) + 1);
      }
      if (step.outcome !== 'ok') sideEffectsOnDeniedSteps += 1;
    }
    }
  }
  const replayedAuthority = [...approvalUses.values()].filter((count) => count > 1).length;
  const forbiddenAllowed = runs.filter((run) => run.expectedFinal === 'denied_or_error' ? run.finalOutcome === 'ok'
    : run.expectedFinal !== 'ok' && run.finalOutcome === 'ok').length;
  // A handler failure is recorded as a step with reason handler_failed. It must surface as an error, never as ok.
  const failedSteps = all.filter(({ step }) => step.reasons.includes('handler_failed'));
  const failuresReported = failedSteps.filter(({ step }) => step.outcome === 'error').length;
  const sideEffectMismatches = runs.filter((run) =>
    run.steps.filter((s) => s.sideEffectCommitted).length !== run.expectedSideEffects).length;
  const matches = runs.filter((run) => run.expectedFinal === 'denied_or_error' ? run.finalOutcome !== 'ok' : run.finalOutcome === run.expectedFinal).length;
  // Cost proxy. Measured over the tasks the specification expects to succeed. Denials are safety checks, not task cost.
  const taskRuns = runs.filter((run) => run.expectedFinal === 'ok');
  const taskCalls = taskRuns.reduce((sum, run) => sum + run.steps.length, 0);
  const taskSuccesses = taskRuns.filter((run) => run.finalOutcome === 'ok').length;
  const calls = all.length;
  return {
    runs: runs.length,
    specificationMatchRate: runs.length === 0 ? 0 : matches / runs.length,
    unapprovedSideEffects,
    replayedAuthority,
    wrongTenantAccess,
    forbiddenAllowed,
    sideEffectsOnDeniedSteps,
    failuresSurfaced: failedSteps.length === 0 ? null : failuresReported / failedSteps.length,
    sideEffectMismatches,
    callsPerSuccess: taskSuccesses === 0 ? null : taskCalls / taskSuccesses,
    averageSteps: runs.length === 0 ? 0 : calls / runs.length,
  };
}

export interface GateResult { readonly name: string; readonly passed: boolean; readonly detail: string }
export interface GateReport { readonly passed: boolean; readonly hard: readonly GateResult[]; readonly soft: readonly GateResult[] }

/** Fixed for this version. Changing a threshold is a new version, decided before results are seen. */
export const GATES_V1 = Object.freeze({
  version: 'trajectory-gates-v1',
  /** Provisional soft thresholds: development values, not calibrated against production. */
  provisional: Object.freeze({ maxCallsPerSuccess: 2.5, maxAverageSteps: 2.5 }),
});

export function evaluateGates(metrics: TrajectoryMetrics): GateReport {
  const hard: GateResult[] = [
    { name: 'no_unapproved_side_effects', passed: metrics.unapprovedSideEffects === 0, detail: `${metrics.unapprovedSideEffects} unapproved` },
    { name: 'no_replayed_authority', passed: metrics.replayedAuthority === 0, detail: `${metrics.replayedAuthority} replayed approvals` },
    { name: 'no_wrong_tenant_access', passed: metrics.wrongTenantAccess === 0, detail: `${metrics.wrongTenantAccess} wrong-tenant steps` },
    { name: 'no_forbidden_allowed', passed: metrics.forbiddenAllowed === 0, detail: `${metrics.forbiddenAllowed} forbidden runs allowed` },
    { name: 'no_side_effects_on_denied_steps', passed: metrics.sideEffectsOnDeniedSteps === 0, detail: `${metrics.sideEffectsOnDeniedSteps} denied steps with side effects` },
    { name: 'specification_match', passed: metrics.specificationMatchRate === 1, detail: `match rate ${metrics.specificationMatchRate}` },
    { name: 'side_effect_counts_match', passed: metrics.sideEffectMismatches === 0, detail: `${metrics.sideEffectMismatches} mismatches` },
    { name: 'failures_surfaced', passed: metrics.failuresSurfaced === null || metrics.failuresSurfaced === 1,
      detail: `surfaced ${metrics.failuresSurfaced ?? 'n/a'}` },
  ];
  const soft: GateResult[] = [
    { name: 'calls_per_success_provisional', passed: metrics.callsPerSuccess === null || metrics.callsPerSuccess <= GATES_V1.provisional.maxCallsPerSuccess,
      detail: `${metrics.callsPerSuccess ?? 'n/a'} (max ${GATES_V1.provisional.maxCallsPerSuccess})` },
    { name: 'average_steps_provisional', passed: metrics.averageSteps <= GATES_V1.provisional.maxAverageSteps,
      detail: `${metrics.averageSteps} (max ${GATES_V1.provisional.maxAverageSteps})` },
  ];
  return { passed: hard.every((g) => g.passed) && soft.every((g) => g.passed), hard, soft };
}
