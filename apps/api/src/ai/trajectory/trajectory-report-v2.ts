import { createHash } from 'node:crypto';
import { efficiencyAdvisories, evaluateGatesV2, findViolations, type RecordedRunV2, type ScenarioClass } from './trajectory-evaluation-v2.js';

/**
 * Evidence report for the v2 evaluator. It lets a reader see what happened, why each decision was accepted or rejected, and
 * whether the observed outcome matched the specification. It never carries raw identifiers, arguments, note text, approval
 * ids or subjects: those are replaced by short SHA-256 digests, which still let two steps be compared.
 */
const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 12);

export interface ReportStep {
  readonly index: number;
  readonly tool: string;
  readonly outcome: string;
  readonly reasons: readonly string[];
  readonly observedStateDelta: number;
  readonly actionDigest: string;
  readonly subjectRef: string;
  readonly consumes: readonly { readonly approvalRef: string; readonly tenantRef: string; readonly consumed: boolean; readonly expired: boolean; readonly digestMatches: boolean }[];
  readonly presentedApprovalRef?: string;
  readonly decision: 'state_changed_under_valid_approval' | 'no_state_change' | 'state_changed_without_valid_approval';
}

export interface ReportRun {
  readonly scenario: string;
  readonly scenarioClass: ScenarioClass;
  readonly kind: 'baseline' | 'control';
  readonly expectedFinal: string;
  readonly observedFinal: string;
  readonly finalMatchesSpecification: boolean;
  readonly expectedStateDelta: number;
  readonly observedStateDelta: number;
  readonly violations: readonly { readonly kind: string; readonly step: number | null; readonly why: string }[];
  readonly controlExpects?: string;
  readonly controlDetected?: boolean;
  readonly steps: readonly ReportStep[];
}

export function buildReportV2(runs: readonly RecordedRunV2[], required: readonly ScenarioClass[]) {
  const reportRuns: ReportRun[] = runs.map((run) => {
    const findings = findViolations(run);
    const observedDelta = run.steps.reduce((sum, s) => sum + s.observedStateDelta, 0);
    const kind = run.controlFor === undefined ? 'baseline' : 'control';
    const detected = run.controlFor === undefined ? undefined : findings.violations.some((v) => v.kind === run.controlFor);
    return {
      scenario: run.scenario, scenarioClass: run.scenarioClass, kind,
      expectedFinal: run.expectedFinal, observedFinal: run.finalOutcome,
      finalMatchesSpecification: run.expectedFinal === 'denied_or_error' ? run.finalOutcome !== 'ok' : run.expectedFinal === run.finalOutcome,
      expectedStateDelta: run.expectedStateDelta, observedStateDelta: observedDelta,
      violations: findings.violations,
      ...(run.controlFor !== undefined ? { controlExpects: run.controlFor, controlDetected: detected } : {}),
      steps: run.steps.map((step, i) => {
        const valid = step.consumes.some((c) => c.consumed && c.tenantId === step.tenantId && c.actionDigest === step.actionDigest && c.subject === step.subject && !c.expired);
        const decision = step.observedStateDelta === 0 ? 'no_state_change' as const
          : valid ? 'state_changed_under_valid_approval' as const : 'state_changed_without_valid_approval' as const;
        return {
          index: i + 1, tool: step.tool, outcome: step.outcome, reasons: step.reasons, observedStateDelta: step.observedStateDelta,
          actionDigest: digest(step.actionDigest), subjectRef: digest(step.subject),
          consumes: step.consumes.map((c) => ({ approvalRef: digest(c.approvalId), tenantRef: digest(c.tenantId), consumed: c.consumed,
            expired: c.expired, digestMatches: c.actionDigest === step.actionDigest })),
          ...(step.presentedApprovalId !== undefined ? { presentedApprovalRef: digest(step.presentedApprovalId) } : {}),
          decision,
        };
      }),
    };
  });
  const gates = evaluateGatesV2(runs, required);
  return {
    format: 'aegis-trajectory-report-v2', gatesVersion: gates.version, passed: gates.passed,
    hardGates: gates.hard, advisory: gates.advisory, coverage: gates.coverage, missedControls: gates.missedControls,
    efficiency: efficiencyAdvisories(runs), runs: reportRuns,
    notice: 'Advisory fields never decide pass or fail. Identifiers are digests. This report is development evidence only.',
  };
}
