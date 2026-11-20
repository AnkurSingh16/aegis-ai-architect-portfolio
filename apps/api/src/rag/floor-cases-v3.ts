import type { LabelledCase } from './abstention-cases.js';

/**
 * Third holdout, written and pre-registered before any run. It is fresh: no question here was used to choose the floor
 * or to inspect a score. It is still one author's set, with the same corpus and the same labelling rules as before.
 *
 * Shape: 12 answerable (three per North document) and 12 unanswerable. The unanswerable set has two kinds:
 * - six off-topic questions, which no document covers;
 * - six South-domain questions. South documents answer them, but the loop runs for the North tenant, so the correct
 *   behaviour is to abstain. These are the kind that produced the false answers in the earlier holdouts.
 *
 * Wording is deliberately less tied to the document text than the earlier sets, so the answerable questions are
 * paraphrases, not quotations.
 */
const login = 'SYNTHETIC-NORTH-LOGIN-INCIDENT';
const mfa = 'SYNTHETIC-NORTH-MFA-GUIDANCE';
const recovery = 'SYNTHETIC-NORTH-ACCOUNT-RECOVERY';
const network = 'SYNTHETIC-NORTH-NETWORK-DIAGNOSTICS';

export const holdoutCasesV3: readonly LabelledCase[] = [
  { id: 'hold3-answer-login-scope', question: 'Before urgency is set on a failed sign-in, how many accounts need to be established as affected?', expected: { kind: 'answer', sourceId: login } },
  { id: 'hold3-answer-login-capture', question: 'What facts about a failed sign-in should an agent write down before doing anything else?', expected: { kind: 'answer', sourceId: login } },
  { id: 'hold3-answer-login-session-token', question: 'If a customer cannot sign in, may the agent ask them to paste their session token?', expected: { kind: 'answer', sourceId: login } },
  { id: 'hold3-answer-mfa-second-method', question: 'What should be confirmed about the second verification method before going further with a prompt failure?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'hold3-answer-mfa-policy-bot', question: 'May a support bot change the sign-in policy to get past a verification prompt?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'hold3-answer-mfa-describe-failure', question: 'How can a user explain a verification failure without sending sensitive data?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'hold3-answer-recovery-before-change', question: 'What has to happen before any account is altered during a recovery case?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'hold3-answer-recovery-never-request', question: 'Which secrets must a recovery message never ask the customer to send back?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'hold3-answer-recovery-doubtful', question: 'Where should a recovery request go when the person cannot be identified with confidence?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'hold3-answer-network-probe', question: 'What does a passing health probe on the loopback address fail to establish?', expected: { kind: 'answer', sourceId: network } },
  { id: 'hold3-answer-network-change-gate', question: 'At what point may a connectivity investigation begin making changes?', expected: { kind: 'answer', sourceId: network } },
  { id: 'hold3-answer-network-components', question: 'Which parts of the local stack should be checked against each other when connectivity is poor?', expected: { kind: 'answer', sourceId: network } },
  { id: 'hold3-abstain-chess-opening', question: 'What is a strong first move for white in chess?', expected: { kind: 'abstain' } },
  { id: 'hold3-abstain-sourdough', question: 'How long should sourdough bread proof at room temperature?', expected: { kind: 'abstain' } },
  { id: 'hold3-abstain-tides', question: 'What causes the ocean tides?', expected: { kind: 'abstain' } },
  { id: 'hold3-abstain-marathon', question: 'How many weeks of training does a first marathon usually need?', expected: { kind: 'abstain' } },
  { id: 'hold3-abstain-python-reverse', question: 'How do I reverse the order of a list in Python?', expected: { kind: 'abstain' } },
  { id: 'hold3-abstain-volcano', question: 'Why do some volcanoes erupt explosively instead of with lava flows?', expected: { kind: 'abstain' } },
  { id: 'hold3-abstain-south-invoice-copy', question: 'Can a customer receive a second copy of an invoice they are disputing?', expected: { kind: 'abstain' } },
  { id: 'hold3-abstain-south-outage-update', question: 'How long can a service outage run before the customer must receive a status update?', expected: { kind: 'abstain' } },
  { id: 'hold3-abstain-south-complaint-exec', question: 'Who may push a customer complaint up to the executive team?', expected: { kind: 'abstain' } },
  { id: 'hold3-abstain-south-credit-size', question: 'How much account credit is given when a service level is missed?', expected: { kind: 'abstain' } },
  { id: 'hold3-abstain-south-policy-gap', question: 'What should an agent do when the written policy does not cover the customer question?', expected: { kind: 'abstain' } },
  { id: 'hold3-abstain-south-amount-mismatch', question: 'Which ledger entries are compared when a payment amount appears wrong?', expected: { kind: 'abstain' } },
];
