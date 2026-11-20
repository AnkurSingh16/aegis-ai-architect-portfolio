import type { LabelledCase } from './abstention-cases.js';

/**
 * Fresh labelled set for the version 4 run (docs/DEV-C4-CITATION-FIX-V4.md). Written and pre-registered before any run.
 * 12 answerable (three per North document) and 12 unanswerable: six off-topic and six South-domain, which the North tenant
 * must not answer. Some answerable questions use words from a neighbouring document, as in version 3. No question repeats
 * wording from any earlier set (a unit test checks this). Still one author.
 */
const login = 'SYNTHETIC-NORTH-LOGIN-INCIDENT';
const mfa = 'SYNTHETIC-NORTH-MFA-GUIDANCE';
const recovery = 'SYNTHETIC-NORTH-ACCOUNT-RECOVERY';
const network = 'SYNTHETIC-NORTH-NETWORK-DIAGNOSTICS';

export const generatorEvalCasesV4: readonly LabelledCase[] = [
  { id: 'gen4-answer-login-what-to-note', question: 'What should an agent write down about the affected sign-in before assigning a severity?', expected: { kind: 'answer', sourceId: login } },
  { id: 'gen4-answer-login-scope-of-impact', question: 'How can an agent tell whether a sign-in problem hits a single synthetic account or the whole test tenant?', expected: { kind: 'answer', sourceId: login } },
  { id: 'gen4-answer-login-secret-requests', question: 'Which secrets must an agent refrain from asking for during a sign-in investigation?', expected: { kind: 'answer', sourceId: login } },
  { id: 'gen4-answer-mfa-factor-device', question: 'What should be checked about the test factor and the device clock when a verification challenge does not work?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'gen4-answer-mfa-auto-policy', question: 'Is an automatic change to the authentication policy an acceptable response to a verification challenge problem?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'gen4-answer-mfa-idp-page', question: 'Which status page may an agent use to look into an identity provider issue during verification?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'gen4-answer-recovery-verify-before', question: 'What verification has to happen before an account is changed in a recovery procedure?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'gen4-answer-recovery-token-ask', question: 'Is it permitted for a recovery message to ask for a bearer token or a one-time code?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'gen4-answer-recovery-unsure-identity', question: 'Who handles recovery requests where the requester identity is still uncertain after checking?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'gen4-answer-network-health-not-auth', question: 'Does a healthy loopback API page show that a tenant request is authorised?', expected: { kind: 'answer', sourceId: network } },
  { id: 'gen4-answer-network-hold-read-only', question: 'How should a connectivity investigation be conducted until an operator approves a change?', expected: { kind: 'answer', sourceId: network } },
  { id: 'gen4-answer-network-note-contents', question: 'What should a local connectivity note record about the symptom and the time?', expected: { kind: 'answer', sourceId: network } },
  { id: 'gen4-abstain-potato-storage', question: 'What temperature is best for storing potatoes over winter?', expected: { kind: 'abstain' } },
  { id: 'gen4-abstain-orchestra-tuning', question: 'Why do orchestras tune to A at the start of a concert?', expected: { kind: 'abstain' } },
  { id: 'gen4-abstain-kettle-descaling', question: 'How often should a kettle be descaled in a hard-water area?', expected: { kind: 'abstain' } },
  { id: 'gen4-abstain-train-tickets', question: 'Are railcards valid on high-speed services in the evening?', expected: { kind: 'abstain' } },
  { id: 'gen4-abstain-poker-odds', question: 'What are the odds of being dealt a pair in the first two cards?', expected: { kind: 'abstain' } },
  { id: 'gen4-abstain-rowing-stroke', question: 'How should a rower time the catch in a single scull?', expected: { kind: 'abstain' } },
  { id: 'gen4-abstain-south-billing-hold', question: 'How long may a billing discrepancy stay on hold before a manager reviews it?', expected: { kind: 'abstain' } },
  { id: 'gen4-abstain-south-degraded-update', question: 'What update must customers receive when a degraded service is still unresolved after two hours?', expected: { kind: 'abstain' } },
  { id: 'gen4-abstain-south-tier-handoff', question: 'What must be handed over when a case moves from tier one to tier three?', expected: { kind: 'abstain' } },
  { id: 'gen4-abstain-south-refund-limit', question: 'What is the upper limit for a refund an agent may approve without review?', expected: { kind: 'abstain' } },
  { id: 'gen4-abstain-south-invoice-period', question: 'Which billing period applies when an invoice is disputed across two months?', expected: { kind: 'abstain' } },
  { id: 'gen4-abstain-south-service-level', question: 'What service level applies to the response time for a standard enterprise ticket?', expected: { kind: 'abstain' } },
];
