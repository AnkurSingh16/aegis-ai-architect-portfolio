import type { LabelledCase } from './abstention-cases.js';

/**
 * Fresh labelled set for the version 3 run (docs/DEV-C4-CITATION-FIX-V3.md). Written and pre-registered before any run.
 * 12 answerable (three per North document) and 12 unanswerable: six off-topic and six South-domain, which the North
 * tenant must not answer. Several answerable questions borrow words from a neighbouring document, to test whether the
 * generator adds a source it does not need. No question repeats wording from any earlier set (a unit test checks this).
 * Still one author.
 */
const login = 'SYNTHETIC-NORTH-LOGIN-INCIDENT';
const mfa = 'SYNTHETIC-NORTH-MFA-GUIDANCE';
const recovery = 'SYNTHETIC-NORTH-ACCOUNT-RECOVERY';
const network = 'SYNTHETIC-NORTH-NETWORK-DIAGNOSTICS';

export const generatorEvalCasesV3: readonly LabelledCase[] = [
  { id: 'gen3-answer-login-timeline-window', question: 'Which two facts about a failed demonstration sign-in must be written down before anything else is checked?', expected: { kind: 'answer', sourceId: login } },
  { id: 'gen3-answer-login-one-or-all', question: 'When a sign-in fails, how does an agent establish whether one synthetic account or every account in the test tenant is affected?', expected: { kind: 'answer', sourceId: login } },
  { id: 'gen3-answer-login-token-request', question: 'May an agent ask a synthetic user for an access token to diagnose a sign-in interruption?', expected: { kind: 'answer', sourceId: login } },
  { id: 'gen3-answer-mfa-test-factor-clock', question: 'Which two things should be confirmed about a second factor and the device when a multi-factor challenge fails?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'gen3-answer-mfa-policy-automation', question: 'Can a support bot change an authentication policy as its response to a multi-factor challenge problem?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'gen3-answer-mfa-status-reference', question: 'What approved reference may an agent check while investigating an identity provider problem during verification?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'gen3-answer-recovery-check-first', question: 'Before any change to an account during a recovery request, what check must be completed?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'gen3-answer-recovery-bearer-secret', question: 'Which secrets, such as a bearer token or one-time code, must not be requested in a recovery message?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'gen3-answer-recovery-unclear-team', question: 'Which team reviews a recovery request when the identity is uncertain?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'gen3-answer-network-loopback-health', question: 'What does a responding loopback health page leave unproven about tenant access and authorisation?', expected: { kind: 'answer', sourceId: network } },
  { id: 'gen3-answer-network-readonly-hold', question: 'Until an operator approves a change, what should a connectivity investigation remain?', expected: { kind: 'answer', sourceId: network } },
  { id: 'gen3-answer-network-symptom-timestamp', question: 'Which browser-visible symptom and time should a local connectivity note contain?', expected: { kind: 'answer', sourceId: network } },
  { id: 'gen3-abstain-tulip-bulbs', question: 'When should tulip bulbs be planted in autumn?', expected: { kind: 'abstain' } },
  { id: 'gen3-abstain-jazz-improvisation', question: 'How do jazz musicians learn to improvise over changes?', expected: { kind: 'abstain' } },
  { id: 'gen3-abstain-cake-altitude', question: 'Why does a cake sink at high altitude?', expected: { kind: 'abstain' } },
  { id: 'gen3-abstain-ferry-timetable', question: 'How far in advance should a ferry ticket be booked for a holiday weekend?', expected: { kind: 'abstain' } },
  { id: 'gen3-abstain-chess-endgame', question: 'What is the basic checkmate pattern with a king and rook?', expected: { kind: 'abstain' } },
  { id: 'gen3-abstain-cricket-spin', question: 'How does a leg spinner generate extra turn on a dry pitch?', expected: { kind: 'abstain' } },
  { id: 'gen3-abstain-south-invoice-correction', question: 'Who approves an invoice correction after a billing review?', expected: { kind: 'abstain' } },
  { id: 'gen3-abstain-south-outage-review', question: 'How long may a degraded service incident stay open before a review is required?', expected: { kind: 'abstain' } },
  { id: 'gen3-abstain-south-escalation-lead', question: 'Which lead signs off when a support case is escalated beyond tier two?', expected: { kind: 'abstain' } },
  { id: 'gen3-abstain-south-credit-calculation', question: 'How is a service credit calculated for a missed response time?', expected: { kind: 'abstain' } },
  { id: 'gen3-abstain-south-ledger-check', question: 'What is the first ledger check when a payment total does not match an invoice?', expected: { kind: 'abstain' } },
  { id: 'gen3-abstain-south-customer-notice', question: 'How much notice must customers receive before a planned service degradation?', expected: { kind: 'abstain' } },
];
