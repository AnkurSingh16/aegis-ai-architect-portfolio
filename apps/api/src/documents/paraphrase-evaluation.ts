/**
 * Development-only paraphrase retrieval set. Queries deliberately avoid the words in the target documents,
 * so this measures where lexical full-text retrieval fails. Labels are engineering-assigned, not human-reviewed.
 * This is not the frozen exploratory dataset and is not a production accuracy claim.
 */
export const paraphraseDatasetVersion = 'aegis-dev-doc-paraphrase-v1';

export const paraphraseCases = [
  { id: 'paraphrase-login', tenant: 'north', query: 'people cannot get into the app', relevantSources: ['SYNTHETIC-NORTH-LOGIN-INCIDENT'] },
  { id: 'paraphrase-mfa', tenant: 'north', query: 'the second verification step keeps failing', relevantSources: ['SYNTHETIC-NORTH-MFA-GUIDANCE'] },
  { id: 'paraphrase-recovery', tenant: 'north', query: 'forgot my details and cannot prove who I am', relevantSources: ['SYNTHETIC-NORTH-ACCOUNT-RECOVERY'] },
  { id: 'paraphrase-health', tenant: 'north', query: 'the local server status page does not respond', relevantSources: ['SYNTHETIC-NORTH-NETWORK-DIAGNOSTICS'] },
  { id: 'paraphrase-billing', tenant: 'south', query: 'charged twice for the same plan', relevantSources: ['SYNTHETIC-SOUTH-BILLING-DISCREPANCY'] },
  { id: 'paraphrase-slow', tenant: 'south', query: 'the application is slow for everyone', relevantSources: ['SYNTHETIC-SOUTH-SERVICE-DEGRADATION'] },
  { id: 'paraphrase-senior', tenant: 'south', query: 'send this to a senior person', relevantSources: ['SYNTHETIC-SOUTH-SUPPORT-ESCALATION'] },
  // Control: short lexical query with known overlap. Longer queries are ANDed by plainto_tsquery and can fall below the rank floor.
  { id: 'control-lexical', tenant: 'north', query: 'user-visible error', relevantSources: ['SYNTHETIC-NORTH-LOGIN-INCIDENT'] },
] as const;
