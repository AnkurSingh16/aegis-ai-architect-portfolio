/**
 * Labelled development cases for the self-correcting answer loop, written before any run and not tuned afterwards.
 * 'answer' cases have one North document that supports the answer. 'abstain' cases have no such document for the
 * North tenant: they are off-topic, or their only support is in another tenant.
 */
export type ExpectedOutcome = { readonly kind: 'answer'; readonly sourceId: string } | { readonly kind: 'abstain' };

export interface LabelledCase {
  readonly id: string;
  readonly question: string;
  readonly expected: ExpectedOutcome;
}

const login = 'SYNTHETIC-NORTH-LOGIN-INCIDENT';
const mfa = 'SYNTHETIC-NORTH-MFA-GUIDANCE';
const recovery = 'SYNTHETIC-NORTH-ACCOUNT-RECOVERY';
const network = 'SYNTHETIC-NORTH-NETWORK-DIAGNOSTICS';

export const abstentionCases: readonly LabelledCase[] = [
  { id: 'answer-login-record', question: 'What should be recorded first for a sign-in interruption?', expected: { kind: 'answer', sourceId: login } },
  { id: 'answer-login-scope', question: 'How can I tell if a login problem affects one account or the whole test tenant?', expected: { kind: 'answer', sourceId: login } },
  { id: 'answer-mfa-challenge', question: 'A multi-factor challenge keeps failing for a test user; what should be checked?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'answer-mfa-clock', question: 'Should the device clock be checked during an MFA problem?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'answer-recovery-verify', question: 'How should an account recovery request be verified?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'answer-recovery-code', question: 'May a support agent ask for a one-time code during recovery?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'answer-network-note', question: 'What should be noted for a local connectivity issue?', expected: { kind: 'answer', sourceId: network } },
  { id: 'answer-network-authz', question: 'Does a healthy API response prove an authenticated request is authorized?', expected: { kind: 'answer', sourceId: network } },
  { id: 'abstain-weather', question: 'What is the weather in Sydney tomorrow?', expected: { kind: 'abstain' } },
  { id: 'abstain-physics', question: 'Explain quantum chromodynamics in two sentences.', expected: { kind: 'abstain' } },
  { id: 'abstain-cooking', question: 'How do I bake sourdough bread at home?', expected: { kind: 'abstain' } },
  { id: 'abstain-travel', question: 'What is the price of a flight to Mumbai next week?', expected: { kind: 'abstain' } },
  { id: 'abstain-south-billing', question: 'How is a billing discrepancy reviewed?', expected: { kind: 'abstain' } },
  { id: 'abstain-south-escalation', question: 'What is the escalation guide when a service degradation is reported?', expected: { kind: 'abstain' } },
  { id: 'abstain-south-general', question: 'What guidance applies when the available evidence does not support an answer?', expected: { kind: 'abstain' } },
];
