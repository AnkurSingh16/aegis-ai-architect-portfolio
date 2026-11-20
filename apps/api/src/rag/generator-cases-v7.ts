import type { LabelledCase } from './abstention-cases.js';

/**
 * Fresh labelled set for prompt v5 (docs/DEV-C4-PROMPT-V5.md). Written by the pipeline's author and pre-registered before
 * any run. Same-author, not independent. 12 answerable (three per North document) and 12 unanswerable: six off-topic and
 * six South-domain. No question repeats wording from any earlier set (a unit test checks this).
 */
const login = 'SYNTHETIC-NORTH-LOGIN-INCIDENT';
const mfa = 'SYNTHETIC-NORTH-MFA-GUIDANCE';
const recovery = 'SYNTHETIC-NORTH-ACCOUNT-RECOVERY';
const network = 'SYNTHETIC-NORTH-NETWORK-DIAGNOSTICS';

export const generatorEvalCasesV7: readonly LabelledCase[] = [
  { id: 'gen7-answer-login-record-first', question: 'Which facts should a tester record first when a demo account cannot complete sign-in?', expected: { kind: 'answer', sourceId: login } },
  { id: 'gen7-answer-login-scope-check', question: 'How do I decide whether a failing sign-in affects one test account or the whole tenant?', expected: { kind: 'answer', sourceId: login } },
  { id: 'gen7-answer-login-forbidden-items', question: 'What must I never ask a tester to send while I investigate a failed log-in?', expected: { kind: 'answer', sourceId: login } },
  { id: 'gen7-answer-mfa-test-factor', question: 'When a verification challenge keeps failing, what should I confirm about the test factor?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'gen7-answer-mfa-policy-edit', question: 'Is it acceptable for a support script to modify the sign-in policy to clear a verification failure?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'gen7-answer-mfa-approved-page', question: 'Which approved page can I use to check whether the identity provider is having trouble?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'gen7-answer-recovery-before-change', question: 'What has to be done before I change anything on a locked account after a recovery request?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'gen7-answer-recovery-description', question: 'If the case description names the requester, is that enough to prove who they are?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'gen7-answer-recovery-uncertain', question: 'Where should a recovery case go when I am not sure who is asking?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'gen7-answer-network-observations', question: 'What should I note about a demo connection problem besides the time it happened?', expected: { kind: 'answer', sourceId: network } },
  { id: 'gen7-answer-network-health-meaning', question: 'If the loopback health page loads, has my tenant request been authorised?', expected: { kind: 'answer', sourceId: network } },
  { id: 'gen7-answer-network-no-changes', question: 'Until an operator approves it, may I change the configuration while looking into a connectivity fault?', expected: { kind: 'answer', sourceId: network } },
  { id: 'gen7-abstain-sprouts', question: 'How long should bean sprouts be rinsed before cooking?', expected: { kind: 'abstain' } },
  { id: 'gen7-abstain-pottery-glaze', question: 'What temperature is needed to fire a stoneware glaze?', expected: { kind: 'abstain' } },
  { id: 'gen7-abstain-comet-tail', question: 'Why does a comet grow a tail when it nears the sun?', expected: { kind: 'abstain' } },
  { id: 'gen7-abstain-salsa-dance', question: 'What is the basic step pattern for salsa?', expected: { kind: 'abstain' } },
  { id: 'gen7-abstain-marathon-pacing', question: 'What pace should a first-time marathoner aim for in the opening miles?', expected: { kind: 'abstain' } },
  { id: 'gen7-abstain-trumpet-valves', question: 'How should trumpet valves be oiled?', expected: { kind: 'abstain' } },
  { id: 'gen7-abstain-south-refund-approver', question: 'Who approves a refund for a southern customer after a billing review?', expected: { kind: 'abstain' } },
  { id: 'gen7-abstain-south-degradation-minutes', question: 'How many minutes of degradation trigger an alert for the southern tenant?', expected: { kind: 'abstain' } },
  { id: 'gen7-abstain-south-escalation-owner', question: 'Who owns an escalation after a southern support lead signs it off?', expected: { kind: 'abstain' } },
  { id: 'gen7-abstain-south-billing-correction', question: 'What correction is applied to a southern invoice after a ledger mismatch is confirmed?', expected: { kind: 'abstain' } },
  { id: 'gen7-abstain-south-status-update', question: 'How often are southern customers updated during an open incident?', expected: { kind: 'abstain' } },
  { id: 'gen7-abstain-south-general-silence', question: 'What should a southern agent tell a customer when the guidance says nothing about their request?', expected: { kind: 'abstain' } },
];
