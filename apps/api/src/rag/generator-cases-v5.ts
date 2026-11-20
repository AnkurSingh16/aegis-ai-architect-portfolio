import type { LabelledCase } from './abstention-cases.js';

/**
 * Independently authored labelled set (docs/DEV-C4-INDEPENDENT-SET.md). The questions were written by a fresh subagent that
 * saw only the eight corpus documents and the format. It saw no earlier question, result or protocol. The labels were
 * checked against the document text by the author of the pipeline, who changed none of them.
 * 12 answerable (three per North document) and 12 unanswerable: six off-topic and six South-domain.
 */
export const generatorEvalCasesV5: readonly LabelledCase[] = [
  { id: 'gen5-001', question: 'A tester says sign-in was interrupted for a demo account. What details should I write down before comparing anything else?', expected: { kind: 'answer', sourceId: 'SYNTHETIC-NORTH-LOGIN-INCIDENT' } },
  { id: 'gen5-002', question: 'How can I tell whether a sign-in problem is limited to one test account or is hitting the whole test tenant?', expected: { kind: 'answer', sourceId: 'SYNTHETIC-NORTH-LOGIN-INCIDENT' } },
  { id: 'gen5-003', question: 'Before a login interruption gets a severity rating, who needs to confirm how far the problem reaches?', expected: { kind: 'answer', sourceId: 'SYNTHETIC-NORTH-LOGIN-INCIDENT' } },
  { id: 'gen5-004', question: 'A user cannot get past a second-factor prompt on a test account. What should I verify first on their side?', expected: { kind: 'answer', sourceId: 'SYNTHETIC-NORTH-MFA-GUIDANCE' } },
  { id: 'gen5-005', question: "Could a support agent fix a stuck multi-factor challenge by switching off the user's verification method?", expected: { kind: 'answer', sourceId: 'SYNTHETIC-NORTH-MFA-GUIDANCE' } },
  { id: 'gen5-006', question: 'When I ask a user about a second-factor screen that is misbehaving, what can they tell me, and what should they keep to themselves?', expected: { kind: 'answer', sourceId: 'SYNTHETIC-NORTH-MFA-GUIDANCE' } },
  { id: 'gen5-007', question: 'A person wants their locked test account restored. What has to happen before anyone changes the account?', expected: { kind: 'answer', sourceId: 'SYNTHETIC-NORTH-ACCOUNT-RECOVERY' } },
  { id: 'gen5-008', question: 'If a recovery ticket already states who the requester is, does that description count as proof of identity?', expected: { kind: 'answer', sourceId: 'SYNTHETIC-NORTH-ACCOUNT-RECOVERY' } },
  { id: 'gen5-009', question: 'Under what circumstances should an account recovery request be handed to the identity support team for a person to review?', expected: { kind: 'answer', sourceId: 'SYNTHETIC-NORTH-ACCOUNT-RECOVERY' } },
  { id: 'gen5-010', question: 'A demo user reports the page will not load locally. Which observations should I capture for the connectivity write-up?', expected: { kind: 'answer', sourceId: 'SYNTHETIC-NORTH-NETWORK-DIAGNOSTICS' } },
  { id: 'gen5-011', question: 'If the local API health page answers normally, does that mean a tenant request is permitted to go through?', expected: { kind: 'answer', sourceId: 'SYNTHETIC-NORTH-NETWORK-DIAGNOSTICS' } },
  { id: 'gen5-012', question: 'During a local connectivity check, am I allowed to alter the configuration myself, or should I keep to read-only checks until an operator signs off?', expected: { kind: 'answer', sourceId: 'SYNTHETIC-NORTH-NETWORK-DIAGNOSTICS' } },
  { id: 'gen5-013', question: 'What is the best way to keep a sourdough starter alive in a warm kitchen?', expected: { kind: 'abstain' } },
  { id: 'gen5-014', question: 'Who won the most recent Premier League match between Arsenal and Chelsea?', expected: { kind: 'abstain' } },
  { id: 'gen5-015', question: 'How many known moons does Jupiter have as of today?', expected: { kind: 'abstain' } },
  { id: 'gen5-016', question: 'What technique do watercolor painters use to create soft edges in a landscape?', expected: { kind: 'abstain' } },
  { id: 'gen5-017', question: 'Who won the most recent Tour de France general classification?', expected: { kind: 'abstain' } },
  { id: 'gen5-018', question: 'How long should I simmer a basic tomato sauce for a rich flavor?', expected: { kind: 'abstain' } },
  { id: 'gen5-019', question: 'How do I dispute a line item on a southern tenant invoice whose total looks wrong?', expected: { kind: 'abstain' } },
  { id: 'gen5-020', question: "Should a refund be issued for last month's billing discrepancy on the southern tenant account?", expected: { kind: 'abstain' } },
  { id: 'gen5-021', question: 'When did the slowdown begin for the southern demo feature, and what was the observed impact?', expected: { kind: 'abstain' } },
  { id: 'gen5-022', question: 'How severe is the southern service degradation, and does it need to go to a support lead for escalation?', expected: { kind: 'abstain' } },
  { id: 'gen5-023', question: 'What criteria would lead a support lead to escalate a southern tenant issue?', expected: { kind: 'abstain' } },
  { id: 'gen5-024', question: 'For the southern tenant, what does the general guidance say a support agent should do when the evidence is incomplete?', expected: { kind: 'abstain' } },
];
