export const retrievalDatasetVersion = 'aegis-synthetic-doc-retrieval-v1';

/** Labels are engineering-reviewed source/query associations, not human-approved production truth. */
export const retrievalEvaluationCases = [
  { id: 'login-triage', tenant: 'north', query: 'synthetic sign in interruption', relevantSources: ['SYNTHETIC-NORTH-LOGIN-INCIDENT'] },
  { id: 'mfa-challenge', tenant: 'north', query: 'multi factor challenge device clock', relevantSources: ['SYNTHETIC-NORTH-MFA-GUIDANCE'] },
  { id: 'recovery-identity', tenant: 'north', query: 'account recovery verify identity', relevantSources: ['SYNTHETIC-NORTH-ACCOUNT-RECOVERY'] },
  { id: 'network-loopback', tenant: 'north', query: 'loopback api health connectivity', relevantSources: ['SYNTHETIC-NORTH-NETWORK-DIAGNOSTICS'] },
  { id: 'billing-invoice', tenant: 'south', query: 'invoice line item discrepancy', relevantSources: ['SYNTHETIC-SOUTH-BILLING-DISCREPANCY'] },
  { id: 'service-impact', tenant: 'south', query: 'service degradation observed impact recovery', relevantSources: ['SYNTHETIC-SOUTH-SERVICE-DEGRADATION'] },
  { id: 'support-escalation', tenant: 'south', query: 'human support lead escalation', relevantSources: ['SYNTHETIC-SOUTH-SUPPORT-ESCALATION'] },
  { id: 'insufficient-guidance', tenant: 'south', query: 'unknown evidence human support guidance', relevantSources: ['SYNTHETIC-SOUTH-GENERAL-GUIDANCE'] },
] as const;

export interface RetrievalObservation { caseId: string; retrievedSourceIdentities: readonly string[] }

export function scoreRetrieval(observations: readonly RetrievalObservation[], topK = 5) {
  if (!Number.isSafeInteger(topK) || topK < 1 || topK > 5) throw new Error('Unsupported retrieval evaluation topK.');
  const byId = new Map(observations.map((observation) => [observation.caseId, observation]));
  const evaluated = retrievalEvaluationCases.map((item) => {
    // This rubric measures source identity retrieval, not chunk multiplicity.
    const found = [...new Set(byId.get(item.id)?.retrievedSourceIdentities ?? [])].slice(0, topK);
    const relevant = new Set<string>(item.relevantSources);
    const relevantCount = found.filter((source) => relevant.has(source)).length;
    const firstRelevant = found.findIndex((source) => relevant.has(source));
    return { relevant: relevantCount, recallDenominator: item.relevantSources.length,
      precisionDenominator: found.length, reciprocalRank: firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1) };
  });
  const relevant = evaluated.reduce((sum, result) => sum + result.relevant, 0);
  const recallDenominator = evaluated.reduce((sum, result) => sum + result.recallDenominator, 0);
  const retrieved = evaluated.reduce((sum, result) => sum + result.precisionDenominator, 0);
  return { datasetVersion: retrievalDatasetVersion, queries: evaluated.length, recallAtK: { numerator: relevant, denominator: recallDenominator,
    rate: recallDenominator ? relevant / recallDenominator : null }, precisionAtK: { numerator: relevant, denominator: retrieved,
    rate: retrieved ? relevant / retrieved : null }, meanReciprocalRank: evaluated.length ? evaluated.reduce((sum, result) => sum + result.reciprocalRank, 0) / evaluated.length : null };
}
