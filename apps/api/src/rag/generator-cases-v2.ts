import type { LabelledCase } from './abstention-cases.js';

/**
 * Fresh labelled set for the citation-fix run (docs/DEV-C4-CITATION-FIX.md). Written and pre-registered before any run.
 * 12 answerable (three per North document) and 12 unanswerable: six off-topic and six South-domain, which the North
 * tenant must not answer. No question repeats wording from any earlier set (a unit test checks this). Still one author.
 */
const login = 'SYNTHETIC-NORTH-LOGIN-INCIDENT';
const mfa = 'SYNTHETIC-NORTH-MFA-GUIDANCE';
const recovery = 'SYNTHETIC-NORTH-ACCOUNT-RECOVERY';
const network = 'SYNTHETIC-NORTH-NETWORK-DIAGNOSTICS';

export const generatorEvalCasesV2: readonly LabelledCase[] = [
  { id: 'gen2-answer-login-window', question: 'What time detail must accompany a report of a broken demonstration sign-in?', expected: { kind: 'answer', sourceId: login } },
  { id: 'gen2-answer-login-scope', question: 'How does an agent tell whether one synthetic account or the whole test tenant is affected?', expected: { kind: 'answer', sourceId: login } },
  { id: 'gen2-answer-login-no-codes', question: 'Which artefacts must never be requested when a synthetic user cannot sign in?', expected: { kind: 'answer', sourceId: login } },
  { id: 'gen2-answer-mfa-clock', question: 'Why should the clock on the phone be checked during a multi-factor problem?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'gen2-answer-mfa-status-page', question: 'Which local status page is approved for checking the identity provider during a verification problem?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'gen2-answer-mfa-policy-change', question: 'Is changing the sign-in policy an allowed automated step for a verification failure?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'gen2-answer-recovery-proof', question: 'Can details typed into a recovery case description serve as proof of identity?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'gen2-answer-recovery-credentials', question: 'Which credential types must a recovery reply leave out?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'gen2-answer-recovery-escalation', question: 'To which team are uncertain identity cases in recovery sent for review?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'gen2-answer-network-health', question: 'Does a passing loopback API health check establish that a tenant request is authorised?', expected: { kind: 'answer', sourceId: network } },
  { id: 'gen2-answer-network-readonly', question: 'Until an operator approves a change, what kind of investigation should connectivity work be?', expected: { kind: 'answer', sourceId: network } },
  { id: 'gen2-answer-network-compare', question: 'Which components should be compared when a local demonstration connectivity issue is investigated?', expected: { kind: 'answer', sourceId: network } },
  { id: 'gen2-abstain-espresso-grind', question: 'What grind size suits an espresso machine?', expected: { kind: 'abstain' } },
  { id: 'gen2-abstain-bread-crust', question: 'Why does bread develop a thick crust in the oven?', expected: { kind: 'abstain' } },
  { id: 'gen2-abstain-eclipse-frequency', question: 'How often do total solar eclipses happen in one place?', expected: { kind: 'abstain' } },
  { id: 'gen2-abstain-violin-strings', question: 'How often should a violin be restrung?', expected: { kind: 'abstain' } },
  { id: 'gen2-abstain-tennis-grip', question: 'What grip is used for a flat tennis serve?', expected: { kind: 'abstain' } },
  { id: 'gen2-abstain-succulent-light', question: 'How much light do succulents need indoors?', expected: { kind: 'abstain' } },
  { id: 'gen2-abstain-south-credit-approver', question: 'Who approves a service credit after a billing investigation?', expected: { kind: 'abstain' } },
  { id: 'gen2-abstain-south-unresolved-hours', question: 'How long can a degraded service remain unresolved before it is escalated?', expected: { kind: 'abstain' } },
  { id: 'gen2-abstain-south-case-owner', question: 'Who owns a support case once it has been escalated to tier two?', expected: { kind: 'abstain' } },
  { id: 'gen2-abstain-south-first-check', question: 'What is the first check when an invoice line appears to be wrong?', expected: { kind: 'abstain' } },
  { id: 'gen2-abstain-south-update-cadence', question: 'How often must a customer receive updates during a service incident?', expected: { kind: 'abstain' } },
  { id: 'gen2-abstain-south-priority-tier', question: 'Which support tier handles a priority-one degradation report?', expected: { kind: 'abstain' } },
];
