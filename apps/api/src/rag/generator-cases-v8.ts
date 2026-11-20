import type { LabelledCase } from './abstention-cases.js';

/**
 * Fresh labelled set for the answer-quality run in docs/DEV-C4-ANSWER-QUALITY-V8-PROTOCOL.md. Written and pre-registered before
 * any run. Same-author, not independent. 12 answerable (three per North document) and 12 unanswerable: six off-topic and six
 * South-domain. No question repeats wording from any earlier set (a unit test checks this).
 */
const login = 'SYNTHETIC-NORTH-LOGIN-INCIDENT';
const mfa = 'SYNTHETIC-NORTH-MFA-GUIDANCE';
const recovery = 'SYNTHETIC-NORTH-ACCOUNT-RECOVERY';
const network = 'SYNTHETIC-NORTH-NETWORK-DIAGNOSTICS';

export const generatorEvalCasesV8: readonly LabelledCase[] = [
  { id: 'gen8-answer-login-first-note', question: 'What facts belong in the first note when a demo log-in stops working?', expected: { kind: 'answer', sourceId: login } },
  { id: 'gen8-answer-login-one-account', question: 'Should I check whether a sign-in interruption is limited to one synthetic account before rating it?', expected: { kind: 'answer', sourceId: login } },
  { id: 'gen8-answer-login-no-secrets', question: 'Which credentials must a support agent never request during a sign-in investigation?', expected: { kind: 'answer', sourceId: login } },
  { id: 'gen8-answer-mfa-factor-check', question: 'What should I confirm about the test factor when a multi-factor prompt is not accepted?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'gen8-answer-mfa-no-disable', question: 'Can a support worker turn off a factor to get past a challenge?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'gen8-answer-mfa-status-page', question: 'Which status page may a support agent look at for the identity provider?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'gen8-answer-recovery-verify-first', question: 'What must happen before anything is altered on an account that is awaiting recovery?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'gen8-answer-recovery-name-proof', question: 'Is the name written in a recovery case description sufficient evidence of identity?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'gen8-answer-recovery-doubt', question: 'Who reviews a recovery request when the identity is in doubt?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'gen8-answer-network-symptoms', question: 'Which symptoms should be written down for a local connectivity fault?', expected: { kind: 'answer', sourceId: network } },
  { id: 'gen8-answer-network-health-allowed', question: 'Does a healthy loopback response mean the tenant request is allowed?', expected: { kind: 'answer', sourceId: network } },
  { id: 'gen8-answer-network-config-edit', question: 'Should configuration be edited while a connection fault is being looked into, before approval?', expected: { kind: 'answer', sourceId: network } },
  { id: 'gen8-abstain-basil', question: 'How do I keep basil fresh after buying it?', expected: { kind: 'abstain' } },
  { id: 'gen8-abstain-ethanol', question: 'Roughly how hot must alcohol get before it starts to boil?', expected: { kind: 'abstain' } },
  { id: 'gen8-abstain-mooring-knots', question: 'Which knots suit mooring a small sailboat?', expected: { kind: 'abstain' } },
  { id: 'gen8-abstain-little-league', question: 'How many innings are in a Little League game?', expected: { kind: 'abstain' } },
  { id: 'gen8-abstain-houseplant', question: 'What is a good first houseplant for low light?', expected: { kind: 'abstain' } },
  { id: 'gen8-abstain-guitar-tuner', question: 'How do I calibrate a guitar tuner?', expected: { kind: 'abstain' } },
  { id: 'gen8-abstain-south-chargebacks', question: 'Which team handles chargebacks for southern accounts?', expected: { kind: 'abstain' } },
  { id: 'gen8-abstain-south-p2-target', question: 'What is the response target for a southern P2 ticket?', expected: { kind: 'abstain' } },
  { id: 'gen8-abstain-south-credit-note', question: 'Who signs off a southern credit note above the threshold?', expected: { kind: 'abstain' } },
  { id: 'gen8-abstain-south-delayed-invoice', question: 'How is a southern customer told about a delayed invoice?', expected: { kind: 'abstain' } },
  { id: 'gen8-abstain-south-regional-cadence', question: 'What reporting cadence applies to southern regional outages?', expected: { kind: 'abstain' } },
  { id: 'gen8-abstain-south-cancel-form', question: 'Which form does a southern customer use to cancel a plan?', expected: { kind: 'abstain' } },
];
