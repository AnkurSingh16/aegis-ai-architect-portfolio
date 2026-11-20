import type { LabelledCase } from './abstention-cases.js';

/**
 * Two new labelled sets, written before any live run.
 * - calibration: used only to choose the similarity floor.
 * - holdout: used once, with the floor chosen from calibration. Not used to choose anything.
 * Neither set overlaps the 15 questions in abstention-cases.ts, which were already observed and are no longer clean.
 */
const login = 'SYNTHETIC-NORTH-LOGIN-INCIDENT';
const mfa = 'SYNTHETIC-NORTH-MFA-GUIDANCE';
const recovery = 'SYNTHETIC-NORTH-ACCOUNT-RECOVERY';
const network = 'SYNTHETIC-NORTH-NETWORK-DIAGNOSTICS';

export const calibrationCases: readonly LabelledCase[] = [
  { id: 'cal-answer-login-details', question: 'Which details should a sign-in interruption record before anything else?', expected: { kind: 'answer', sourceId: login } },
  { id: 'cal-answer-login-one-account', question: 'How do I decide if a sign-in problem hits only one synthetic account?', expected: { kind: 'answer', sourceId: login } },
  { id: 'cal-answer-mfa-status-page', question: 'Which status page can a support agent review for a multi-factor problem?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'cal-answer-mfa-clock', question: 'What should be checked about the device clock when a challenge fails?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'cal-answer-mfa-disable', question: 'Can a factor be disabled as an automated support step?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'cal-answer-recovery-identity', question: 'Who handles uncertain identity cases during account recovery?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'cal-answer-recovery-never', question: 'What must never be requested in a support message about recovery?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'cal-answer-recovery-verify-first', question: 'Should a recovery change happen before the user is verified?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'cal-answer-network-health', question: 'What is the loopback API health page used for during a connectivity problem?', expected: { kind: 'answer', sourceId: network } },
  { id: 'cal-answer-network-readonly', question: 'Should connectivity investigation change configuration before approval?', expected: { kind: 'answer', sourceId: network } },
  { id: 'cal-abstain-calories', question: 'How many calories are in a banana?', expected: { kind: 'abstain' } },
  { id: 'cal-abstain-football', question: 'Who won the football world cup in 1998?', expected: { kind: 'abstain' } },
  { id: 'cal-abstain-curry', question: 'Give me a recipe for vegetable curry.', expected: { kind: 'abstain' } },
  { id: 'cal-abstain-ethanol', question: 'What is the boiling point of ethanol?', expected: { kind: 'abstain' } },
  { id: 'cal-abstain-puppy', question: 'How do I train a puppy to sit?', expected: { kind: 'abstain' } },
  { id: 'cal-abstain-south-documentation', question: 'How should a billing discrepancy be documented and escalated?', expected: { kind: 'abstain' } },
  { id: 'cal-abstain-south-degradation', question: 'What is the procedure when service degradation affects many customers?', expected: { kind: 'abstain' } },
  { id: 'cal-abstain-south-enterprise', question: 'Which team takes support escalations for enterprise accounts?', expected: { kind: 'abstain' } },
  { id: 'cal-abstain-south-awaiting-review', question: 'What general guidance applies to customers awaiting a human review?', expected: { kind: 'abstain' } },
  { id: 'cal-abstain-south-refunds', question: 'How are customer refunds approved after a billing review?', expected: { kind: 'abstain' } },
];

export const holdoutCases: readonly LabelledCase[] = [
  { id: 'hold-answer-login-window', question: 'What should a sign-in investigation record about the time window?', expected: { kind: 'answer', sourceId: login } },
  { id: 'hold-answer-mfa-policy', question: 'Is a multi-factor problem a reason to change the authentication policy?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'hold-answer-mfa-clock-why', question: 'Why compare the device clock during multi-factor troubleshooting?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'hold-answer-network-authz', question: 'Which evidence proves a request is authorized, according to the network notes?', expected: { kind: 'answer', sourceId: network } },
  { id: 'hold-answer-network-readonly', question: 'What should remain read-only during a local connectivity investigation?', expected: { kind: 'answer', sourceId: network } },
  { id: 'hold-answer-recovery-before-change', question: 'What is required before any account recovery change is made?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'hold-answer-recovery-unconfirmed', question: 'How should a support agent treat an identity case it cannot confirm?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'hold-answer-recovery-secrets', question: 'What must a user never send in a support message about a password reset?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'hold-abstain-capital', question: 'What is the capital city of Canada?', expected: { kind: 'abstain' } },
  { id: 'hold-abstain-lentils', question: 'How long should I simmer lentils?', expected: { kind: 'abstain' } },
  { id: 'hold-abstain-charts', question: 'Which songs topped the charts in 2005?', expected: { kind: 'abstain' } },
  { id: 'hold-abstain-solar', question: 'How does a solar panel generate electricity?', expected: { kind: 'abstain' } },
  { id: 'hold-abstain-south-refund', question: 'What service handles a refund request for a billing discrepancy?', expected: { kind: 'abstain' } },
  { id: 'hold-abstain-south-degraded', question: 'What is the escalation path for a degraded service in the south tenant?', expected: { kind: 'abstain' } },
  { id: 'hold-abstain-south-guidance', question: "How should a South customer's general guidance be phrased?", expected: { kind: 'abstain' } },
  { id: 'hold-abstain-south-invoice', question: 'What are the steps to resolve a billing discrepancy invoice?', expected: { kind: 'abstain' } },
];
