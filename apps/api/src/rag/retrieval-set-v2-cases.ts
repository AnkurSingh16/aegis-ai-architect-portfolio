import type { LabelledCase } from './abstention-cases.js';

/**
 * Fresh labelled set for docs/DEV-C4-RETRIEVAL-SET-PROTOCOL.md, step 1 only. Written before any retrieval was run on it. The
 * selection check (step 2) has not run, so no question has been kept or dropped yet. Same-author, not independent. Twelve
 * answerable (three per North document) and twelve unanswerable: six off-topic and six South-domain. No question repeats
 * wording from any earlier set (a unit test checks this).
 */
const login = 'SYNTHETIC-NORTH-LOGIN-INCIDENT';
const mfa = 'SYNTHETIC-NORTH-MFA-GUIDANCE';
const recovery = 'SYNTHETIC-NORTH-ACCOUNT-RECOVERY';
const network = 'SYNTHETIC-NORTH-NETWORK-DIAGNOSTICS';

export const retrievalSetV2Cases: readonly LabelledCase[] = [
  { id: 'rs2-answer-login-first-entry', question: 'What is the first thing a tester should write down when a demo login stops working?', expected: { kind: 'answer', sourceId: login } },
  { id: 'rs2-answer-login-everyone-or-one', question: 'How can I find out whether a sign-in problem hits everyone or just one demo user?', expected: { kind: 'answer', sourceId: login } },
  { id: 'rs2-answer-login-never-share', question: 'Which credentials or secrets must a tester never be asked to share during a login problem?', expected: { kind: 'answer', sourceId: login } },
  { id: 'rs2-answer-mfa-enrolled-method', question: 'A one-time code is rejected every time for a test user; what about their enrolled method should be checked?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'rs2-answer-mfa-rule-change', question: 'Could a helper change the sign-in rules to clear a second-step verification error?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'rs2-answer-mfa-official-resource', question: 'What official resource should I consult to see if the identity service is degraded?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'rs2-answer-recovery-before-alter', question: 'What verification has to happen before I alter a frozen account after a recovery request?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'rs2-answer-recovery-name-enough', question: 'Is a requester name written in the case enough evidence of who they are?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'rs2-answer-recovery-unknown-caller', question: 'If I cannot tell who is contacting support about a locked account, which route applies?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'rs2-answer-network-report-details', question: 'Besides when it occurred, what details should accompany a connection failure report?', expected: { kind: 'answer', sourceId: network } },
  { id: 'rs2-answer-network-status-endpoint', question: 'Does a local status endpoint responding confirm a tenant request is permitted?', expected: { kind: 'answer', sourceId: network } },
  { id: 'rs2-answer-network-config-edit', question: 'Can I edit the connection configuration during a connectivity investigation before sign-off?', expected: { kind: 'answer', sourceId: network } },
  { id: 'rs2-abstain-pour-over', question: 'How do I brew a proper pour-over coffee?', expected: { kind: 'abstain' } },
  { id: 'rs2-abstain-lower-back', question: 'What is a good stretching routine for lower back pain?', expected: { kind: 'abstain' } },
  { id: 'rs2-abstain-metal-primer', question: 'Which paint primer suits metal railings?', expected: { kind: 'abstain' } },
  { id: 'rs2-abstain-water-polo', question: 'How many players are on a water polo team?', expected: { kind: 'abstain' } },
  { id: 'rs2-abstain-brown-rice', question: 'What is the boiling time for brown rice?', expected: { kind: 'abstain' } },
  { id: 'rs2-abstain-puppy-lead', question: 'How do I train a puppy to walk on a lead?', expected: { kind: 'abstain' } },
  { id: 'rs2-abstain-south-price-exception', question: 'Which regional manager approves southern price exceptions?', expected: { kind: 'abstain' } },
  { id: 'rs2-abstain-south-dispute-window', question: 'How long does a southern customer have to dispute a charge?', expected: { kind: 'abstain' } },
  { id: 'rs2-abstain-south-sla-sev2', question: 'What is the southern SLA for a severity two ticket?', expected: { kind: 'abstain' } },
  { id: 'rs2-abstain-south-digest', question: 'Who receives the southern weekly incident digest?', expected: { kind: 'abstain' } },
  { id: 'rs2-abstain-south-freeze-window', question: 'When is the southern product freeze window?', expected: { kind: 'abstain' } },
  { id: 'rs2-abstain-south-admin-onboarding', question: 'What is the southern onboarding checklist for new admins?', expected: { kind: 'abstain' } },
];
