import type { LabelledCase } from './abstention-cases.js';

/**
 * Fresh labelled set for docs/DEV-C4-RETRIEVAL-SET-V3-PROTOCOL.md. Written before any retrieval is run on it. Same-author, not
 * independent. Every answerable label was checked against the North document text in documents/catalog.ts before this file
 * was committed. Each primary answerable question has one pre-assigned spare from the same document (`replacesId`). The spares
 * were written now, so a replacement is mechanical and is not chosen from retrieval results.
 */
export interface SpareCase extends LabelledCase {
  readonly replacesId: string;
}

const login = 'SYNTHETIC-NORTH-LOGIN-INCIDENT';
const mfa = 'SYNTHETIC-NORTH-MFA-GUIDANCE';
const recovery = 'SYNTHETIC-NORTH-ACCOUNT-RECOVERY';
const network = 'SYNTHETIC-NORTH-NETWORK-DIAGNOSTICS';

export const retrievalSetV3Primary: readonly LabelledCase[] = [
  { id: 'rs3-answer-login-stalled-sign-in', question: "When someone's demo sign-in keeps stalling, what should be logged before anything else?", expected: { kind: 'answer', sourceId: login } },
  { id: 'rs3-answer-login-isolated-or-tenant', question: 'How do I tell whether a sign-in failure is isolated or hitting the whole test tenant?', expected: { kind: 'answer', sourceId: login } },
  { id: 'rs3-answer-login-sensitive-items', question: 'Which sensitive items must support staff refuse to collect during a sign-in incident?', expected: { kind: 'answer', sourceId: login } },
  { id: 'rs3-answer-mfa-prompt-failing', question: 'Why would a verification prompt keep failing even though the user typed it correctly?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'rs3-answer-mfa-disable-check', question: 'Is it permitted to disable the two-step check on an account to unblock a tester?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'rs3-answer-mfa-provider-outage', question: 'Where can support confirm whether the identity provider has an ongoing outage?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'rs3-answer-recovery-before-change', question: 'Before changing a locked account on a recovery request, what must be checked?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'rs3-answer-recovery-named-requester', question: 'Does a case that names the requester prove who that person is?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'rs3-answer-recovery-unclear-caller', question: "If a caller's identity cannot be established, where should the request go?", expected: { kind: 'answer', sourceId: recovery } },
  { id: 'rs3-answer-network-symptom-note', question: 'What should be noted about a connectivity symptom besides when it happened?', expected: { kind: 'answer', sourceId: network } },
  { id: 'rs3-answer-network-health-authorised', question: 'Is a tenant request authorised just because the local health endpoint answers?', expected: { kind: 'answer', sourceId: network } },
  { id: 'rs3-answer-network-settings-before-signoff', question: 'May an engineer change connection settings while a fault awaits sign-off?', expected: { kind: 'answer', sourceId: network } },
  { id: 'rs3-abstain-kimchi', question: 'How long should cabbage ferment for kimchi?', expected: { kind: 'abstain' } },
  { id: 'rs3-abstain-tent-pegs', question: 'Which tent pegs work best on rocky ground?', expected: { kind: 'abstain' } },
  { id: 'rs3-abstain-bicycle-chain', question: 'How often should a bicycle chain be lubricated?', expected: { kind: 'abstain' } },
  { id: 'rs3-abstain-sourdough-hydration', question: 'What hydration level suits a beginner sourdough loaf?', expected: { kind: 'abstain' } },
  { id: 'rs3-abstain-chess-opening', question: 'Which chess opening suits an aggressive player?', expected: { kind: 'abstain' } },
  { id: 'rs3-abstain-bonsai-repot', question: 'When should a juniper bonsai be repotted?', expected: { kind: 'abstain' } },
  { id: 'rs3-abstain-south-quota', question: 'How is the southern sales quota reset each quarter?', expected: { kind: 'abstain' } },
  { id: 'rs3-abstain-south-hotline', question: "What is the southern hotline's weekend coverage schedule?", expected: { kind: 'abstain' } },
  { id: 'rs3-abstain-south-warranty-price', question: 'How is a southern warranty extension priced?', expected: { kind: 'abstain' } },
  { id: 'rs3-abstain-south-courier', question: 'Which courier is contracted for southern deliveries?', expected: { kind: 'abstain' } },
  { id: 'rs3-abstain-south-escalation-cap', question: 'How many escalations can a southern agent hold at once?', expected: { kind: 'abstain' } },
  { id: 'rs3-abstain-south-auditor', question: 'Which auditor reviews the southern tenant each year?', expected: { kind: 'abstain' } },
];

/** One spare per primary answerable question, from the same document. Used only when that primary ranks first. */
export const retrievalSetV3Spares: readonly SpareCase[] = [
  { id: 'rs3-spare-login-time-and-error', replacesId: 'rs3-answer-login-stalled-sign-in', question: 'Which time window and error wording should a failed demo sign-in report include?', expected: { kind: 'answer', sourceId: login } },
  { id: 'rs3-spare-login-scope-before-severity', replacesId: 'rs3-answer-login-isolated-or-tenant', question: 'How should a support agent judge whether a sign-in problem affects one account or the tenant before assigning severity?', expected: { kind: 'answer', sourceId: login } },
  { id: 'rs3-spare-login-no-password-sent', replacesId: 'rs3-answer-login-sensitive-items', question: 'Are testers allowed to send a password or recovery code while a login problem is investigated?', expected: { kind: 'answer', sourceId: login } },
  { id: 'rs3-spare-mfa-factor-and-clock', replacesId: 'rs3-answer-mfa-prompt-failing', question: 'What should be checked about the test factor and the device clock when a challenge fails?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'rs3-spare-mfa-no-policy-change', replacesId: 'rs3-answer-mfa-disable-check', question: 'Can an automated tool change the authentication policy to clear a failing challenge?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'rs3-spare-mfa-approved-status-page', replacesId: 'rs3-answer-mfa-provider-outage', question: 'Which approved page may a support agent review for identity provider status?', expected: { kind: 'answer', sourceId: mfa } },
  { id: 'rs3-spare-recovery-escalation-team', replacesId: 'rs3-answer-recovery-unclear-caller', question: 'Who must review an uncertain identity case before a recovery is performed?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'rs3-spare-recovery-description-not-proof', replacesId: 'rs3-answer-recovery-named-requester', question: 'Can an unlock be performed based only on details written in the case description?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'rs3-spare-recovery-never-request', replacesId: 'rs3-answer-recovery-before-change', question: 'What must never be requested in a support message during account recovery?', expected: { kind: 'answer', sourceId: recovery } },
  { id: 'rs3-spare-network-browser-and-health', replacesId: 'rs3-answer-network-symptom-note', question: 'What should be recorded about the browser-visible symptom and the loopback health page?', expected: { kind: 'answer', sourceId: network } },
  { id: 'rs3-spare-network-health-not-proof', replacesId: 'rs3-answer-network-health-authorised', question: 'Does a successful health response prove an authenticated tenant request was allowed?', expected: { kind: 'answer', sourceId: network } },
  { id: 'rs3-spare-network-read-only', replacesId: 'rs3-answer-network-settings-before-signoff', question: 'Until an operator approves it, what kind of work should a connectivity investigation remain?', expected: { kind: 'answer', sourceId: network } },
];
