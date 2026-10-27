import { TRIAGE_WARNING, type SyntheticCaseId, type TriageResult } from './contracts/triage.js';

const recommendations: Record<SyntheticCaseId, Pick<TriageResult, 'category' | 'priority' | 'suggestedTeam' | 'rationale' | 'nextStep'>> = {
  'SYNTHETIC-LOGIN-001': {
    category: 'incident', priority: 'high', suggestedTeam: 'Platform support',
    rationale: 'The synthetic login outage blocks all invented users, so this fixture receives high priority.',
    nextStep: 'Ask a human to review the synthetic incident checklist before considering escalation.',
  },
  'SYNTHETIC-BILLING-002': {
    category: 'billing', priority: 'medium', suggestedTeam: 'Billing support',
    rationale: 'The synthetic duplicate invoice needs billing review but does not block service access.',
    nextStep: 'Ask a human to compare the invented invoice records. No refund or account change is performed.',
  },
  'SYNTHETIC-GUIDANCE-003': {
    category: 'guidance', priority: 'low', suggestedTeam: 'Customer support',
    rationale: 'The synthetic documentation question is informational and reports no service disruption.',
    nextStep: 'Suggest that a human share the demonstration onboarding guide. No message is sent.',
  },
};

/** Fixed fixture lookup, not inference. No persistence, external calls or executed actions. */
export function triageCase(caseId: SyntheticCaseId): TriageResult {
  return { mode: 'synthetic-mock', caseId, ...recommendations[caseId], warning: TRIAGE_WARNING };
}
