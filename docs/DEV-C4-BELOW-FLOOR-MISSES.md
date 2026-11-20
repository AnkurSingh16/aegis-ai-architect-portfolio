# C4 generator: answerable questions missed below the 0.70 floor

Post-hoc analysis of recorded runs. It uses only the per-case records already written to the scratchpad. It runs no
model, changes no floor and no prompt, and does not count as a pre-registered result. The sets used here are spent.

## Scope

Five recorded generator runs, 24 cases each: the first run (`c4-generator-run1.json`), the citation fix versions 2 to 4, and
the independent set (`c4-independent-v4-run1.json`). Across them: 60 unanswerable cases and 60 answerable cases.

## The eight answerable misses below the floor

Each one was abstained with `insufficient_evidence`, meaning no retrieved item reached 0.70, so the generator never saw it.

| Run | Case | Top score | Top-ranked source | Expected source |
|---|---|---|---|---|
| first | `gen-answer-login-no-secrets` | 0.673 | ACCOUNT-RECOVERY | LOGIN-INCIDENT |
| first | `gen-answer-mfa-device-setting` | 0.687 | MFA-GUIDANCE | MFA-GUIDANCE |
| first | `gen-answer-mfa-reference-page` | 0.687 | ACCOUNT-RECOVERY | MFA-GUIDANCE |
| first | `gen-answer-recovery-session-token` | 0.683 | ACCOUNT-RECOVERY | ACCOUNT-RECOVERY |
| first | `gen-answer-network-note` | 0.662 | NETWORK-DIAGNOSTICS | NETWORK-DIAGNOSTICS |
| v2 | `gen2-answer-recovery-credentials` | 0.694 | ACCOUNT-RECOVERY | ACCOUNT-RECOVERY |
| v4 | `gen4-answer-login-secret-requests` | 0.646 | LOGIN-INCIDENT | LOGIN-INCIDENT |
| independent | `gen5-006` | 0.667 | MFA-GUIDANCE | MFA-GUIDANCE |

## What the misses share

- **Six of eight had the right document ranked first.** Their scores are 0.646 to 0.694. This is a boundary problem: the
  document was found, but its score did not reach 0.70.
- **Two of eight had the wrong document ranked first.** `gen-answer-login-no-secrets` and `gen-answer-mfa-reference-page`
  both ranked ACCOUNT-RECOVERY above the expected document, at 0.673 and 0.687. This is a ranking problem.
- All eight scores fall in the band 0.646 to 0.694, just below the floor.

## The unanswerable side

Across the 60 unanswerable cases, the highest top-ranked scores were:

- 0.681 `gen2-abstain-south-update-cadence`
- 0.666 `gen4-abstain-south-service-level`
- 0.665 `gen-abstain-south-intermittent`
- 0.664 `gen3-abstain-south-outage-review`
- 0.663 `gen5-024`

Five of 60 scored 0.66 or above. One scored 0.67 or above.

## What this means

- A floor lower than 0.70 would recover most of the six boundary misses, but it would also admit some unanswerable
  questions. The scores overlap in the 0.66 to 0.69 band, so no single cut separates the two groups in these records.
- Choosing a new floor from these records would be tuning on sets that have already been observed. It is not evidence for
  a new floor.
- The two ranking misses are a different problem. Lowering the floor would not fix them. Their correct document was not
  ranked first, so only a retrieval change would.

## Options (none decided)

1. **Reformulation.** Enable the loop's retry with a reworded query when the first round abstains. This changes the loop
   policy, so it needs its own pre-registered set and protocol.
2. **Retrieval changes** such as a reranker or hybrid lexical search, aimed at the two ranking misses. These need a new set
   and protocol.
3. **A new floor** chosen from a new pre-registered calibration set, with its own holdout. Only this option can answer the
   boundary question directly.

No option is recommended here. The owner decides which, if any, to pursue.
