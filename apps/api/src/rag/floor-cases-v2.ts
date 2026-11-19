import type { LabelledCase } from './abstention-cases.js';
import { calibrationCases } from './floor-cases.js';

/**
 * Second round of labelled sets, written before the run. Still one author, so these are not independent of each other
 * or of the first round. They are larger, and they reach more of each document.
 * - calibrationCasesV2: the first calibration set plus these additions. Used only to choose the floor, by the same rule.
 * - holdoutCasesV2: fresh. Used once, with the floor chosen from calibrationCasesV2.
 * The first holdout and the original 15 have been observed and are reference only.
 */
const login = 'SYNTHETIC-NORTH-LOGIN-INCIDENT';
const mfa = 'SYNTHETIC-NORTH-MFA-GUIDANCE';
const recovery = 'SYNTHETIC-NORTH-ACCOUNT-RECOVERY';
const network = 'SYNTHETIC-NORTH-NETWORK-DIAGNOSTICS';

const calibrationAdditions: readonly LabelledCase[] = [
  { id: 'cal2-answer-mfa-test-factor', question: 'What should a support agent confirm about the test factor when a challenge fails?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'cal2-answer-mfa-disable-factor', question: 'Can a support agent turn off a multi-factor method on their own?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'cal2-answer-mfa-status-reference', question: 'Which page may a support agent look at to check an identity provider problem?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'cal2-answer-login-affected-account', question: 'When a user describes a sign-in interruption, which account should be recorded?', expected: { kind: 'answer', sourceId: login } },
  { id: 'cal2-answer-login-timeline', question: 'Does a sign-in issue need checking against the health timeline?', expected: { kind: 'answer', sourceId: login } },
  { id: 'cal2-answer-login-severity', question: 'Who reviews the severity of a sign-in case before it is assigned?', expected: { kind: 'answer', sourceId: login } },
  { id: 'cal2-answer-recovery-unverified', question: 'Should an account recovery be done without verifying the person?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'cal2-answer-recovery-bearer-token', question: 'Is a bearer token something a recovery message may ask for?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'cal2-answer-recovery-unclear-identity', question: 'How should an unclear identity case be escalated during recovery?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'cal2-answer-network-health-auth', question: 'Does a healthy health response show that a tenant request is authorized?', expected: { kind: 'answer', sourceId: network } },
  { id: 'cal2-answer-network-timestamp', question: 'Which timestamp detail belongs in a local demonstration connectivity note?', expected: { kind: 'answer', sourceId: network } },
  { id: 'cal2-answer-network-readonly', question: 'Should an investigation stay read-only until an operator approves a change?', expected: { kind: 'answer', sourceId: network } },
  { id: 'cal2-abstain-mountain', question: 'What is the tallest mountain in Africa?', expected: { kind: 'abstain' } },
  { id: 'cal2-abstain-car-oil', question: 'How do I change the oil in a car?', expected: { kind: 'abstain' } },
  { id: 'cal2-abstain-whaling-novel', question: 'Summarise the plot of a classic novel about whaling.', expected: { kind: 'abstain' } },
  { id: 'cal2-abstain-exchange-rate', question: 'What is the exchange rate for dollars to yen today?', expected: { kind: 'abstain' } },
  { id: 'cal2-abstain-basketball', question: 'How many players are on a basketball team?', expected: { kind: 'abstain' } },
  { id: 'cal2-abstain-tomatoes', question: 'What is the best time to plant tomatoes?', expected: { kind: 'abstain' } },
  { id: 'cal2-abstain-south-dispute', question: 'Which documentation is required when a customer disputes an invoice?', expected: { kind: 'abstain' } },
  { id: 'cal2-abstain-south-degraded-open', question: 'How long does a degraded service incident stay open before escalation?', expected: { kind: 'abstain' } },
  { id: 'cal2-abstain-south-enterprise-contact', question: 'What is the enterprise escalation contact for a support case?', expected: { kind: 'abstain' } },
  { id: 'cal2-abstain-south-waiting', question: 'What should a customer be told while waiting for a human review?', expected: { kind: 'abstain' } },
  { id: 'cal2-abstain-south-refund-approver', question: 'Who approves refunds after a billing review?', expected: { kind: 'abstain' } },
  { id: 'cal2-abstain-south-billing-first', question: 'What does a billing discrepancy investigation check first?', expected: { kind: 'abstain' } },
];

export const calibrationCasesV2: readonly LabelledCase[] = [...calibrationCases, ...calibrationAdditions];

export const holdoutCasesV2: readonly LabelledCase[] = [
  { id: 'hold2-answer-login-window', question: 'What must be written down about the time window when a sign-in breaks?', expected: { kind: 'answer', sourceId: login } },
  { id: 'hold2-answer-mfa-policy-automation', question: 'Is changing the authentication policy an automated response to an MFA problem?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'hold2-answer-mfa-clock', question: 'Why is the clock on the device relevant to a multi-factor challenge?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'hold2-answer-mfa-reference', question: 'Which status page is the approved local identity-provider reference?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'hold2-answer-recovery-evidence', question: 'What evidence is insufficient to prove an identity in a recovery request?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'hold2-answer-recovery-timing', question: 'Should a recovery request be processed before a human check?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'hold2-answer-recovery-reply', question: 'What should a recovery reply avoid asking for?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'hold2-answer-network-loopback', question: 'Which network note records whether the loopback health page responds?', expected: { kind: 'answer', sourceId: network } },
  { id: 'hold2-answer-network-hold', question: 'How should a connectivity investigation be kept while waiting for approval?', expected: { kind: 'answer', sourceId: network } },
  { id: 'hold2-answer-network-authenticated', question: 'Does an authenticated tenant request follow from a healthy health page?', expected: { kind: 'answer', sourceId: network } },
  { id: 'hold2-answer-network-symptom', question: 'What exact symptom should be captured in a local connectivity note?', expected: { kind: 'answer', sourceId: network } },
  { id: 'hold2-answer-network-note-detail', question: 'Which detail should be noted with the timestamp of a demonstration connectivity problem?', expected: { kind: 'answer', sourceId: network } },
  { id: 'hold2-abstain-seasons', question: 'What causes the seasons on Earth?', expected: { kind: 'abstain' } },
  { id: 'hold2-abstain-chai', question: 'Which spices go into a chai?', expected: { kind: 'abstain' } },
  { id: 'hold2-abstain-mars-moons', question: 'How many moons does Mars have?', expected: { kind: 'abstain' } },
  { id: 'hold2-abstain-stretching', question: 'What is a good stretching routine for runners?', expected: { kind: 'abstain' } },
  { id: 'hold2-abstain-bees', question: 'How do bees communicate the location of flowers?', expected: { kind: 'abstain' } },
  { id: 'hold2-abstain-offside', question: 'What is the rule for offside in football?', expected: { kind: 'abstain' } },
  { id: 'hold2-abstain-south-correction', question: 'Who signs off on a billing discrepancy correction?', expected: { kind: 'abstain' } },
  { id: 'hold2-abstain-south-degraded-review', question: 'What steps does a degraded service review take for customers?', expected: { kind: 'abstain' } },
  { id: 'hold2-abstain-south-service-credit', question: 'How is a service credit calculated for a billing error?', expected: { kind: 'abstain' } },
  { id: 'hold2-abstain-south-response-times', question: 'What is the general customer guidance on response times?', expected: { kind: 'abstain' } },
  { id: 'hold2-abstain-south-invoice-dispute', question: 'How are invoices disputed by a customer?', expected: { kind: 'abstain' } },
  { id: 'hold2-abstain-south-triage', question: 'Which team triages degraded services in the south tenant?', expected: { kind: 'abstain' } },
];
