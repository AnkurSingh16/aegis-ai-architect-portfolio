/** Browser-safe shared contract. All records are invented demonstration fixtures. */
export const syntheticCases = [
  { id: 'SYNTHETIC-LOGIN-001', title: 'Login outage', description: 'An invented workspace cannot sign in. All synthetic users receive a 503 error.' },
  { id: 'SYNTHETIC-BILLING-002', title: 'Duplicate invoice', description: 'An invented account received two invoices for the same demonstration subscription.' },
  { id: 'SYNTHETIC-GUIDANCE-003', title: 'Documentation request', description: 'An invented user asks where to find the demonstration onboarding guide.' },
] as const;

export type SyntheticCaseId = typeof syntheticCases[number]['id'];
export type TriageRequest = { caseId: SyntheticCaseId };
export const categories = ['incident', 'billing', 'guidance'] as const;
export const priorities = ['high', 'medium', 'low'] as const;
export const suggestedTeams = ['Platform support', 'Billing support', 'Customer support'] as const;
export const TRIAGE_WARNING = 'Synthetic mock only. No real AI, retrieval, customer data or actions.';

export interface TriageResult {
  mode: 'synthetic-mock';
  caseId: SyntheticCaseId;
  category: typeof categories[number];
  priority: typeof priorities[number];
  suggestedTeam: typeof suggestedTeams[number];
  rationale: string;
  nextStep: string;
  warning: typeof TRIAGE_WARNING;
}

export const triageRequestSchema = {
  type: 'object',
  required: ['caseId'],
  additionalProperties: false,
  properties: { caseId: { type: 'string', enum: syntheticCases.map((item) => item.id) } },
} as const;

export const triageResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['mode', 'caseId', 'category', 'priority', 'suggestedTeam', 'rationale', 'nextStep', 'warning'],
  properties: {
    mode: { const: 'synthetic-mock' },
    caseId: { type: 'string', enum: syntheticCases.map((item) => item.id) },
    category: { type: 'string', enum: categories },
    priority: { type: 'string', enum: priorities },
    suggestedTeam: { type: 'string', enum: suggestedTeams },
    rationale: { type: 'string', minLength: 1, maxLength: 500 },
    nextStep: { type: 'string', minLength: 1, maxLength: 500 },
    warning: { const: TRIAGE_WARNING },
  },
} as const;

function boundedText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 500;
}

/** Validate the untrusted HTTP response before rendering, including request identity. */
export function isTriageResult(value: unknown, expectedCaseId: SyntheticCaseId): value is TriageResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return Object.keys(result).length === triageResponseSchema.required.length
    && triageResponseSchema.required.every((key) => Object.hasOwn(result, key))
    && result.mode === 'synthetic-mock'
    && syntheticCases.some((item) => item.id === result.caseId)
    && result.caseId === expectedCaseId
    && categories.some((item) => item === result.category)
    && priorities.some((item) => item === result.priority)
    && suggestedTeams.some((item) => item === result.suggestedTeam)
    && boundedText(result.rationale)
    && boundedText(result.nextStep)
    && result.warning === TRIAGE_WARNING;
}
