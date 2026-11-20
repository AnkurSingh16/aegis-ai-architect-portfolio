import type { LabelledCase } from './abstention-cases.js';

/**
 * Fourth round of labelled sets for the similarity floor (docs/DEV-C4-FLOOR-V4.md). Written by the pipeline's author and
 * pre-registered before any run. Same-author, not independent.
 * - calibrationCasesV4: 20 answerable and 20 unanswerable. Used only to choose the floor, with the fixed rule.
 * - holdoutCasesV4: 12 answerable and 12 unanswerable, fresh. Used once, at the floor the calibration chose.
 * No question repeats wording from any earlier set (a unit test checks this).
 */
const login = 'SYNTHETIC-NORTH-LOGIN-INCIDENT';
const mfa = 'SYNTHETIC-NORTH-MFA-GUIDANCE';
const recovery = 'SYNTHETIC-NORTH-ACCOUNT-RECOVERY';
const network = 'SYNTHETIC-NORTH-NETWORK-DIAGNOSTICS';

export const calibrationCasesV4: readonly LabelledCase[] = [
  { id: 'floor4-answer-login-1', question: 'What should be captured about a broken demo sign-in before severity is discussed?', expected: { kind: 'answer', sourceId: login } },
  { id: 'floor4-answer-login-2', question: 'Which tenant-level question separates a single bad account from a wider sign-in outage?', expected: { kind: 'answer', sourceId: login } },
  { id: 'floor4-answer-login-3', question: 'When reporting a failed demo log-in, which time information is required?', expected: { kind: 'answer', sourceId: login } },
  { id: 'floor4-answer-login-4', question: 'Does the health timeline play a role when a sign-in complaint comes in?', expected: { kind: 'answer', sourceId: login } },
  { id: 'floor4-answer-login-5', question: 'Should an agent ask a customer to read out a one-time code during a failed sign-in?', expected: { kind: 'answer', sourceId: login } },
  { id: 'floor4-answer-mfa-1', question: 'A second-step prompt keeps failing for a demo user. Which factor should be confirmed present?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'floor4-answer-mfa-2', question: 'Can a support agent reconfigure the sign-in policy as a fix for a verification prompt problem?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'floor4-answer-mfa-3', question: "What is wrong with an agent turning off a user's verification method?", expected: { kind: 'answer', sourceId: mfa } },
  { id: 'floor4-answer-mfa-4', question: 'Which reference status page is approved for identity provider questions in local testing?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'floor4-answer-mfa-5', question: 'If a verification prompt looks wrong, what does the user need to describe without giving a code?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'floor4-answer-recovery-1', question: 'What must be established before an account is modified following a restore request?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'floor4-answer-recovery-2', question: 'Is a stated name in a restore ticket enough to confirm who is asking?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'floor4-answer-recovery-3', question: 'Which secret types must a restore message never request?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'floor4-answer-recovery-4', question: 'To whom is an unclear restore request passed for a decision?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'floor4-answer-recovery-5', question: 'Can a locked account be reopened by an agent without a human verification step?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'floor4-answer-network-1', question: 'What observations belong in a local connectivity write-up besides the timestamp?', expected: { kind: 'answer', sourceId: network } },
  { id: 'floor4-answer-network-2', question: 'Does an OK from the loopback API health page prove request authorisation?', expected: { kind: 'answer', sourceId: network } },
  { id: 'floor4-answer-network-3', question: 'What posture should a demo connectivity investigation take before an operator approves changes?', expected: { kind: 'answer', sourceId: network } },
  { id: 'floor4-answer-network-4', question: 'Which local services should be compared when a demonstration connection fails?', expected: { kind: 'answer', sourceId: network } },
  { id: 'floor4-answer-network-5', question: 'Should database and web app health be copied with credentials into the note?', expected: { kind: 'answer', sourceId: network } },
  { id: 'floor4-abstain-coffee-roast', question: 'What roast level brings out the most sweetness in a light coffee?', expected: { kind: 'abstain' } },
  { id: 'floor4-abstain-hiking-boots', question: 'How should leather hiking boots be broken in before a trek?', expected: { kind: 'abstain' } },
  { id: 'floor4-abstain-sunflower', question: 'How tall do sunflowers typically grow in full sun?', expected: { kind: 'abstain' } },
  { id: 'floor4-abstain-violin-bow', question: 'What tension should a violin bow hair have?', expected: { kind: 'abstain' } },
  { id: 'floor4-abstain-tennis-court', question: 'How wide is a standard doubles tennis court?', expected: { kind: 'abstain' } },
  { id: 'floor4-abstain-basalt', question: 'How is basalt formed when lava cools?', expected: { kind: 'abstain' } },
  { id: 'floor4-abstain-rice-water', question: 'What water ratio works for long-grain rice on a stove?', expected: { kind: 'abstain' } },
  { id: 'floor4-abstain-stunt-kite', question: 'Which wind speeds are best for flying a stunt kite?', expected: { kind: 'abstain' } },
  { id: 'floor4-abstain-chess-castling', question: 'How do you castle kingside in chess?', expected: { kind: 'abstain' } },
  { id: 'floor4-abstain-humpback-song', question: 'Why do humpback whales sing?', expected: { kind: 'abstain' } },
  { id: 'floor4-abstain-south-invoice-hold', question: 'How long may a disputed invoice remain on hold for a southern customer?', expected: { kind: 'abstain' } },
  { id: 'floor4-abstain-south-outage-refund', question: 'Is a refund automatic after a multi-hour outage on the southern tenant?', expected: { kind: 'abstain' } },
  { id: 'floor4-abstain-south-case-priority', question: 'Which priority does a southern service degradation receive by default?', expected: { kind: 'abstain' } },
  { id: 'floor4-abstain-south-review-board', question: 'Who sits on the southern billing review board?', expected: { kind: 'abstain' } },
  { id: 'floor4-abstain-south-credit-expiry', question: 'When do service credits expire for southern accounts?', expected: { kind: 'abstain' } },
  { id: 'floor4-abstain-south-status-page', question: 'Which status page does the southern team publish incidents to?', expected: { kind: 'abstain' } },
  { id: 'floor4-abstain-south-discrepancy-days', question: 'How many business days does a southern billing discrepancy investigation take?', expected: { kind: 'abstain' } },
  { id: 'floor4-abstain-south-degradation-owner', question: 'Who owns a degraded feature on the southern tenant after handover?', expected: { kind: 'abstain' } },
  { id: 'floor4-abstain-south-escalation-criteria', question: 'What duration triggers escalation for a southern customer complaint?', expected: { kind: 'abstain' } },
  { id: 'floor4-abstain-south-general-fallback', question: 'What should a southern agent say when the policy text is silent on a request?', expected: { kind: 'abstain' } },
];

export const holdoutCasesV4: readonly LabelledCase[] = [
  { id: 'floor4h-answer-login-first-facts', question: 'What facts about a failed demo sign-in should be logged first?', expected: { kind: 'answer', sourceId: login } },
  { id: 'floor4h-answer-login-cookie', question: 'Is it fine to ask a customer for their session cookie during a sign-in problem?', expected: { kind: 'answer', sourceId: login } },
  { id: 'floor4h-answer-login-isolated', question: 'How do we judge whether a sign-in fault is isolated or tenant-wide?', expected: { kind: 'answer', sourceId: login } },
  { id: 'floor4h-answer-mfa-device', question: 'What should be checked on the verification device before escalating a challenge problem?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'floor4h-answer-mfa-automated', question: 'Can an automated process alter the MFA policy after a challenge fails?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'floor4h-answer-mfa-status', question: 'Which local identity status page should be checked during a verification incident?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'floor4h-answer-recovery-human', question: 'Before a restore request modifies an account, what human step is required?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'floor4h-answer-recovery-otp', question: 'Can a recovery reply ask for a one-time code?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'floor4h-answer-recovery-escalate', question: 'When is a restore request escalated to the identity team?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'floor4h-answer-network-health', question: 'What does a passing loopback health check not establish?', expected: { kind: 'answer', sourceId: network } },
  { id: 'floor4h-answer-network-readonly', question: 'How long should a connectivity investigation remain read-only?', expected: { kind: 'answer', sourceId: network } },
  { id: 'floor4h-answer-network-symptom', question: 'What symptom detail accompanies a local connectivity note?', expected: { kind: 'answer', sourceId: network } },
  { id: 'floor4h-abstain-green-tea', question: 'What is the ideal brewing time for green tea?', expected: { kind: 'abstain' } },
  { id: 'floor4h-abstain-bees', question: 'How do bees decide which flower to visit?', expected: { kind: 'abstain' } },
  { id: 'floor4h-abstain-asian-desert', question: 'What is the largest desert in Asia?', expected: { kind: 'abstain' } },
  { id: 'floor4h-abstain-guitar', question: 'How many strings does a standard guitar have?', expected: { kind: 'abstain' } },
  { id: 'floor4h-abstain-thunder', question: 'What causes thunder during a storm?', expected: { kind: 'abstain' } },
  { id: 'floor4h-abstain-whetstone', question: 'How do you sharpen a kitchen knife on a whetstone?', expected: { kind: 'abstain' } },
  { id: 'floor4h-abstain-south-credit-memo', question: 'How is a disputed credit memo handled for a southern account?', expected: { kind: 'abstain' } },
  { id: 'floor4h-abstain-south-exception', question: 'Which team approves a southern service exception?', expected: { kind: 'abstain' } },
  { id: 'floor4h-abstain-south-notice', question: 'What is the notice period for southern customers before contract renewal?', expected: { kind: 'abstain' } },
  { id: 'floor4h-abstain-south-review-trigger', question: 'How many incidents trigger a review for the southern tenant per month?', expected: { kind: 'abstain' } },
  { id: 'floor4h-abstain-south-payment-hold', question: 'Who may release a hold on a southern customer payment?', expected: { kind: 'abstain' } },
  { id: 'floor4h-abstain-south-enterprise-target', question: 'What is the response target for southern enterprise tickets?', expected: { kind: 'abstain' } },
];
