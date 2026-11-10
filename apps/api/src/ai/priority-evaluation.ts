import { priorities } from '../contracts/triage.js';

export const priorityDatasetVersion = 'aegis-priority-regression-v1';

/** Engineering-reviewed synthetic labels, declared before any model output is evaluated. */
export const priorityScenarios = [
  { id: 'wide-sign-in-outage', severity: 'broad-confirmed-impact', expected: 'high', rationale: 'Multiple synthetic users cannot authenticate and a service error is confirmed.' },
  { id: 'single-user-lockout', severity: 'single-user-blocked', expected: 'medium', rationale: 'One invented user is blocked while other synthetic users can sign in.' },
  { id: 'intermittent-login-delay', severity: 'intermittent-degradation', expected: 'medium', rationale: 'A limited intermittent delay is reported without confirmed outage scope.' },
  { id: 'possible-token-misuse', severity: 'security-concern-unverified', expected: 'high', rationale: 'A synthetic report raises a possible security concern requiring immediate human review.' },
  { id: 'duplicate-invoice-review', severity: 'financial-discrepancy', expected: 'medium', rationale: 'A duplicated synthetic invoice is visible but no payment loss is established.' },
  { id: 'minor-invoice-formatting', severity: 'cosmetic-billing-question', expected: 'low', rationale: 'A demonstration invoice formatting question has no reported financial impact.' },
  { id: 'missing-onboarding-guide', severity: 'information-request', expected: 'low', rationale: 'A synthetic user requests routine onboarding information.' },
  { id: 'service-status-unknown', severity: 'impact-unknown', expected: 'medium', rationale: 'The synthetic report indicates degradation but the scope and duration are unknown.' },
  { id: 'recovery-proof-unclear', severity: 'identity-verification-required', expected: 'high', rationale: 'An account recovery concern cannot be verified from the synthetic case and requires specialist review.' },
] as const satisfies readonly { id: string; severity: string; expected: typeof priorities[number]; rationale: string }[];

export interface PriorityObservation { scenarioId: string; priority: string }

/** Scores only supplied observations; it does not produce or validate model answers. */
export function scorePriority(observations: readonly PriorityObservation[]) {
  const observed = new Map(observations.map((item) => [item.scenarioId, item.priority]));
  const matched = priorityScenarios.filter((scenario) => observed.get(scenario.id) === scenario.expected).length;
  const valid = priorityScenarios.filter((scenario) => priorities.includes(observed.get(scenario.id) as typeof priorities[number])).length;
  return { datasetVersion: priorityDatasetVersion, labelStatus: 'engineering-reviewed', scenarios: priorityScenarios.length,
    exactMatch: { numerator: matched, denominator: priorityScenarios.length, rate: matched / priorityScenarios.length },
    validPriority: { numerator: valid, denominator: priorityScenarios.length, rate: valid / priorityScenarios.length } };
}
