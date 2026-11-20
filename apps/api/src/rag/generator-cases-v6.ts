import type { LabelledCase } from './abstention-cases.js';

/**
 * Labelled set for the reformulation run (docs/DEV-C4-REFORMULATION.md). Written by the pipeline's author and
 * pre-registered before any run. It is same-author, not independent. Answerable questions are paraphrased to share few
 * exact words with the documents, because that is where first-round retrieval fell below the floor.
 * 12 answerable (three per North document) and 12 unanswerable: six off-topic and six South-domain.
 */
const login = 'SYNTHETIC-NORTH-LOGIN-INCIDENT';
const mfa = 'SYNTHETIC-NORTH-MFA-GUIDANCE';
const recovery = 'SYNTHETIC-NORTH-ACCOUNT-RECOVERY';
const network = 'SYNTHETIC-NORTH-NETWORK-DIAGNOSTICS';

export const generatorEvalCasesV6: readonly LabelledCase[] = [
  { id: 'reform-answer-login-first-note', question: 'What facts about an interrupted demo session belong in the first note?', expected: { kind: 'answer', sourceId: login } },
  { id: 'reform-answer-login-single-user', question: 'How do I find out if a log-in fault is confined to a single trial user?', expected: { kind: 'answer', sourceId: login } },
  { id: 'reform-answer-login-credentials', question: 'Which credentials should never be solicited during a failed access attempt?', expected: { kind: 'answer', sourceId: login } },
  { id: 'reform-answer-mfa-first-check', question: 'A person second verification step keeps rejecting them. What is the first thing to check?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'reform-answer-mfa-deactivate', question: 'May a helper deactivate someone additional verification method to get them in?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'reform-answer-mfa-provider-outage', question: 'Where can an operator look up a provider outage affecting identity checks?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'reform-answer-recovery-confirm', question: 'Before touching a locked profile after a restore request, what must be confirmed?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'reform-answer-recovery-ticket-claim', question: 'Does a written statement of who I am in a ticket establish my identity?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'reform-answer-recovery-hazy-identity', question: 'When someone identity is hazy, to whom should the restore request go?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'reform-answer-network-page-note', question: 'What should be jotted down about a page that refuses to load on a demo machine?', expected: { kind: 'answer', sourceId: network } },
  { id: 'reform-answer-network-status-endpoint', question: 'If the service status endpoint responds, can I assume my account may act?', expected: { kind: 'answer', sourceId: network } },
  { id: 'reform-answer-network-observe-only', question: 'While awaiting sign-off, should troubleshooting change settings or only observe?', expected: { kind: 'answer', sourceId: network } },
  { id: 'reform-abstain-cheese-riesling', question: 'Which cheese pairs best with a dry riesling?', expected: { kind: 'abstain' } },
  { id: 'reform-abstain-running-shoes', question: 'How often should running shoes be replaced?', expected: { kind: 'abstain' } },
  { id: 'reform-abstain-mercury-year', question: 'How long does a year take on Mercury?', expected: { kind: 'abstain' } },
  { id: 'reform-abstain-rose-pruning', question: 'When should roses be pruned in a temperate climate?', expected: { kind: 'abstain' } },
  { id: 'reform-abstain-piano-scale', question: 'Which scale should a beginner learn first on piano?', expected: { kind: 'abstain' } },
  { id: 'reform-abstain-sicilian', question: 'What is the Sicilian Defence in chess?', expected: { kind: 'abstain' } },
  { id: 'reform-abstain-south-chargeback', question: 'What steps follow a chargeback filed against a southern account?', expected: { kind: 'abstain' } },
  { id: 'reform-abstain-south-downtime-notice', question: 'How much notice is owed to southern customers before planned downtime?', expected: { kind: 'abstain' } },
  { id: 'reform-abstain-south-escalation-chain', question: 'Who sits in the southern escalation chain above tier two?', expected: { kind: 'abstain' } },
  { id: 'reform-abstain-south-credit-cap', question: 'What is the cap on service credits for the southern tenant?', expected: { kind: 'abstain' } },
  { id: 'reform-abstain-south-invoice-audit', question: 'Who audits invoices issued to southern customers each quarter?', expected: { kind: 'abstain' } },
  { id: 'reform-abstain-south-outage-major', question: 'How is an outage classified as major on the southern tenant?', expected: { kind: 'abstain' } },
];
