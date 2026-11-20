import type { LabelledCase } from './abstention-cases.js';

/**
 * Fresh labelled set for docs/DEV-C4-RERANK-PROTOCOL.md. Written by the pipeline's author and pre-registered before any run.
 * Same-author, not independent. Twelve answerable (three per North document) and twelve unanswerable: six off-topic and
 * six South-domain. The expected document is not verified to be in the top five, or to be ranked second, before the run;
 * the run reports each question's actual rank. No question repeats wording from any earlier set (a unit test checks this).
 */
const login = 'SYNTHETIC-NORTH-LOGIN-INCIDENT';
const mfa = 'SYNTHETIC-NORTH-MFA-GUIDANCE';
const recovery = 'SYNTHETIC-NORTH-ACCOUNT-RECOVERY';
const network = 'SYNTHETIC-NORTH-NETWORK-DIAGNOSTICS';

export const retrievalRerankCasesV1: readonly LabelledCase[] = [
  { id: 'rr1-answer-login-first-note', question: 'Which details go into the first note when a sign-in attempt keeps being refused?', expected: { kind: 'answer', sourceId: login } },
  { id: 'rr1-answer-login-one-account', question: 'What should I check to tell if a sign-in fault is limited to one account?', expected: { kind: 'answer', sourceId: login } },
  { id: 'rr1-answer-login-off-limits', question: 'What information is off limits to request from a tester during a sign-in investigation?', expected: { kind: 'answer', sourceId: login } },
  { id: 'rr1-answer-mfa-device', question: 'What should I verify about the second-factor device when the code prompt rejects every try?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'rr1-answer-mfa-policy-script', question: 'Can a script change the authentication policy to get past a second-factor error?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'rr1-answer-mfa-status-page', question: 'Which status page is authorised for checking identity provider problems?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'rr1-answer-recovery-confirm', question: 'What must be confirmed before editing a locked account following a recovery ticket?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'rr1-answer-recovery-named', question: 'Does naming the requester in the ticket establish their identity?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'rr1-answer-recovery-doubt', question: 'Who should handle a recovery request when the requester identity is doubtful?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'rr1-answer-network-record', question: 'What else besides the timestamp should be recorded for a connection fault?', expected: { kind: 'answer', sourceId: network } },
  { id: 'rr1-answer-network-health', question: 'Does a successful loopback health check mean the tenant call was authorised?', expected: { kind: 'answer', sourceId: network } },
  { id: 'rr1-answer-network-settings', question: 'Is it allowed to alter the settings while a connectivity problem is under review, before approval?', expected: { kind: 'answer', sourceId: network } },
  { id: 'rr1-abstain-cheese', question: 'How long does cheese need to age for a sharp flavour?', expected: { kind: 'abstain' } },
  { id: 'rr1-abstain-cutting-board', question: 'What wood is best for a cutting board?', expected: { kind: 'abstain' } },
  { id: 'rr1-abstain-egg-calories', question: 'How many calories are in a boiled egg?', expected: { kind: 'abstain' } },
  { id: 'rr1-abstain-sailing-knot', question: 'Which knots hold best on a sailing rope?', expected: { kind: 'abstain' } },
  { id: 'rr1-abstain-offside', question: 'What is the offside rule in football?', expected: { kind: 'abstain' } },
  { id: 'rr1-abstain-cast-iron', question: 'How do I care for a cast iron pan?', expected: { kind: 'abstain' } },
  { id: 'rr1-abstain-south-warranty', question: 'Which team reviews southern warranty claims?', expected: { kind: 'abstain' } },
  { id: 'rr1-abstain-south-reseller-tier', question: 'What discount tier applies to a southern reseller order?', expected: { kind: 'abstain' } },
  { id: 'rr1-abstain-south-ack-time', question: 'How quickly must a southern outage be acknowledged?', expected: { kind: 'abstain' } },
  { id: 'rr1-abstain-south-amendment', question: 'Who signs off a southern contract amendment?', expected: { kind: 'abstain' } },
  { id: 'rr1-abstain-south-chat-retention', question: 'What is the southern data retention period for chat logs?', expected: { kind: 'abstain' } },
  { id: 'rr1-abstain-south-billing-close', question: 'When does the southern billing cycle close?', expected: { kind: 'abstain' } },
];
