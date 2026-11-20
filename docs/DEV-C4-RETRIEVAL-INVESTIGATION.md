# C4 retrieval investigation: below-floor answerable cases and the wrong-document-first case

Scope: what the existing records show. No new embedding or model run was made, because the owner has not authorised another
live evaluation. The threshold stays at 0.70.

## What the records show (set v8, prompt v5, one run)

Source: the v8 run report (scores are the top vector score, and the top source, for each case).

Answerable cases below the 0.70 floor:

| Case | Top score | Top source | Correct document first? | Reading |
| --- | --- | --- | --- | --- |
| `gen8-answer-login-first-note` | 0.691 | login incident | yes | Boundary miss. Score 0.009 under the floor |
| `gen8-answer-login-no-secrets` | 0.678 | account recovery | **no** | Ranking miss. The login document was not first |
| `gen8-answer-network-config-edit` | 0.640 | network diagnostics | yes | Below the floor by 0.060 |

Above the floor but withheld by the answer-text guard (output problem, not retrieval):

- `gen8-answer-recovery-doubt` (0.776) and `gen8-answer-network-symptoms` (0.734). Both abstained because the answer had no
  text of its own. Retrieval was correct.

Unanswerable cases: top scores ranged from 0.472 to 0.637. The highest unanswerable score (0.637) sits just below the lowest
answerable score that was not withheld (0.640). The gap between answerable and unanswerable scores on this set is therefore
about 0.003 at the bottom of the answerable range, and the floor is not a clean separator here.

## What this tells us

- The wrong-document-first case is one case. It may be a property of the question's wording, not a general ranking failure.
- The boundary misses sit within about 0.06 of the floor. Lowering the floor would admit the unanswerable cases at 0.637 and
  above, so it cannot be done safely on this evidence. The owner has retained 0.70.
- The records do not show the rank of the correct document for the wrong-first case, nor the scores of all 50 chunks. Those
  are needed to tell a ranking problem from a score-scale problem.

## Candidate changes, each needing its own rationale and separate evaluation

None is adopted. Each would need a pre-registered protocol and a run only after separate authorisation.

1. **Query reformulation before retrieval.** The loop already supports reformulation, which is off in the route. Risk: a
   reformulated query can pull in unsupported evidence and raise false answers. Evaluate with the unanswerable set as the
   control.
2. **Larger candidate pool and reranking.** An earlier order-only reranker was rejected on a set that did not test ranking
   (`docs/DEV-C4-RERANK-PROTOCOL.md`). Reranking can reorder, but it cannot raise a score, so it cannot by itself answer a
   question the floor rejects. Risk of more false answers if the rerank promotes an unrelated chunk.
3. **Chunking and wording of the corpus.** The North documents are short single paragraphs. Changing the corpus changes the
   evaluation, so this is a corpus change, not a retrieval change.
4. **Score normalisation for the floor.** Changes the meaning of 0.70 and would need the owner's decision and a new
   calibration. Not recommended on this evidence.

## Required before any retrieval change

- A labelled evaluation that includes the three cases above and the unanswerable controls, on an independently written set
  (see the independent kit). The v8 cases cannot be used as fresh evidence.
- The full rank and score list for each case, recorded in the report.
- The owner's authorisation for the live run.
