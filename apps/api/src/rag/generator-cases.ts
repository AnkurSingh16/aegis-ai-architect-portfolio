import type { LabelledCase } from './abstention-cases.js';

/**
 * Labelled set for the live answer generator, written and pre-registered before any run (see
 * docs/DEV-C4-GENERATOR-EVALUATION.md). Fresh wording: no question repeats an earlier calibration or holdout set.
 * Still one author, so it is not independent.
 *
 * 12 answerable (three per North document) and 12 unanswerable: six off-topic and six South-domain. The North tenant
 * must abstain on South-domain questions.
 */
const login = 'SYNTHETIC-NORTH-LOGIN-INCIDENT';
const mfa = 'SYNTHETIC-NORTH-MFA-GUIDANCE';
const recovery = 'SYNTHETIC-NORTH-ACCOUNT-RECOVERY';
const network = 'SYNTHETIC-NORTH-NETWORK-DIAGNOSTICS';

export const generatorEvalCases: readonly LabelledCase[] = [
  { id: 'gen-answer-login-account', question: 'Which account should a support person note first when a demo user cannot get past sign-in?', expected: { kind: 'answer', sourceId: login } },
  { id: 'gen-answer-login-timeline', question: 'What should be compared with the service health timeline when a login complaint arrives?', expected: { kind: 'answer', sourceId: login } },
  { id: 'gen-answer-login-no-secrets', question: 'Which items must a support agent refrain from requesting when helping someone who cannot log in?', expected: { kind: 'answer', sourceId: login } },
  { id: 'gen-answer-mfa-device-setting', question: 'Which device setting might make a second-step verification fail?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'gen-answer-mfa-reference-page', question: 'Which approved reference page can an agent consult for an identity provider incident?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'gen-answer-mfa-no-factor-removal', question: 'Can a support agent switch off a user second verification factor as an automated fix?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'gen-answer-recovery-before-edit', question: 'What must a support team do before modifying an account after a recovery request?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'gen-answer-recovery-session-token', question: 'Is a session token something a recovery message is allowed to solicit?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'gen-answer-recovery-unclear', question: 'Where is an identity case sent when the requester identity remains unclear?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'gen-answer-network-note', question: 'Which facts belong in a local connectivity note alongside the time?', expected: { kind: 'answer', sourceId: network } },
  { id: 'gen-answer-network-posture', question: 'What posture should a connectivity investigation take until an operator signs off?', expected: { kind: 'answer', sourceId: network } },
  { id: 'gen-answer-network-health-proof', question: 'If the loopback health endpoint returns OK, has an authorized tenant request been proven?', expected: { kind: 'answer', sourceId: network } },
  { id: 'gen-abstain-cycling-gears', question: 'How should a beginner set the gears on a road bike?', expected: { kind: 'abstain' } },
  { id: 'gen-abstain-poaching', question: 'What temperature should water be kept at for poaching eggs?', expected: { kind: 'abstain' } },
  { id: 'gen-abstain-star-colour', question: 'Why do stars change colour as they age?', expected: { kind: 'abstain' } },
  { id: 'gen-abstain-blues-chords', question: 'Which chord progression is common in blues music?', expected: { kind: 'abstain' } },
  { id: 'gen-abstain-compost', question: 'How long does compost take to mature in a home bin?', expected: { kind: 'abstain' } },
  { id: 'gen-abstain-rugby-tackle', question: 'What is the penalty for a late tackle in rugby union?', expected: { kind: 'abstain' } },
  { id: 'gen-abstain-south-review-days', question: 'How many days does a billing review take before a refund decision?', expected: { kind: 'abstain' } },
  { id: 'gen-abstain-south-notify-hour', question: 'Should customers be notified when a degraded service has lasted over an hour?', expected: { kind: 'abstain' } },
  { id: 'gen-abstain-south-director-signoff', question: 'Who signs off on an escalation to the account director?', expected: { kind: 'abstain' } },
  { id: 'gen-abstain-south-ledger-period', question: 'Which ledger period is checked when an invoice total is disputed?', expected: { kind: 'abstain' } },
  { id: 'gen-abstain-south-response-window', question: 'What is the support team response window for a priority-two ticket?', expected: { kind: 'abstain' } },
  { id: 'gen-abstain-south-intermittent', question: 'How is impact recorded when a feature is intermittently unavailable?', expected: { kind: 'abstain' } },
];
