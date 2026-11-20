# C4 retrieval set v3: pre-assigned spares and the rank check (pre-registered, not yet run)

Recorded before any retrieval is run on set v3. The set is in `apps/api/src/rag/retrieval-set-v3-cases.ts`.

## Why

Set v2 (`docs/DEV-C4-RETRIEVAL-SET-PROTOCOL.md`, step 2 result) ended with five answerable questions. Seven of twelve were
ranked first and dropped, and no replacements had been written in advance, so none could be added without selecting on the
results. Set v3 fixes this by writing the replacements first.

## The set

- Twelve primary answerable questions: three per North document.
- Twelve unanswerable questions: six off-topic and six South-domain.
- Twelve spare answerable questions: one per primary question, from the same document. Each spare is pre-assigned to one
  primary question through `replacesId`, and was written before any retrieval was run on v3.
- Every answerable label was checked against the North text in `apps/api/src/documents/catalog.ts` before the set was
  committed. Each spare states a fact that the same document states.
- No question repeats wording from any earlier set, including set v2 and the rerank set. A unit test checks this.
- Same-author. The result must say so.

## The rank check (raw vector retrieval only)

Same as step 2 of `docs/DEV-C4-RETRIEVAL-SET-PROTOCOL.md`: the route's embedding model, top five, no reranker, no generator,
no floor. For each answerable question, record the rank of its expected document (or absent) and the top score. For every
unanswerable question, record the top score.

## Replacement rule (fixed now, mechanical)

1. A primary answerable question ranked first is **dropped and replaced by its pre-assigned spare**. The spare is checked the
   same way.
2. If the spare is also ranked first, it is **dropped and not replaced again**. The record says so.
3. A primary answerable question ranked second to fifth, or absent, is **kept**. Its spare is not used.
4. No question is written, edited or substituted after the rank check has run.

## Measures (fixed now)

- The final kept set: how many answerable questions remain, and which primary or spare each one is.
- The count of replacements and of second-time drops.
- Top-one accuracy and mean reciprocal rank of the expected document on the kept answerable questions, raw order only.
  These describe retrieval on this set. They are not a comparison with any candidate.
- The distribution of top scores on kept answerable and on unanswerable questions, reported as found. Not used to set the floor.

## Limits

- Same-author. An independent author would be stronger.
- Retrieval on synthetic North text, one embedding model, one run.
- A set of this size cannot separate candidates on small differences: one question moves top-one accuracy by about eight points
  when twelve are kept.
- Any candidate (for example a reranker or a boundary change) needs its own pre-registered protocol, its own rule, and its own
  run, before it is measured on this set. Nothing here accepts or rejects one.

## Status

Set written and tested. The rank check has not been run. It is not run by this document.

## Result: rank check run once (raw vector retrieval, top five)

Run on 2026-11-20 with `apps/api/src/rag/retrieval-set-v3-rank-check.integration.test.ts`, which checks every primary and every
spare. The output is kept outside the repository. This was one run, and the rule below was applied to its output without change.

### Primary answerable questions

Nine of twelve were ranked first. Their pre-assigned spares were also ranked first, so each one was dropped and not replaced again:

- `rs3-answer-login-stalled-sign-in`, `rs3-answer-login-isolated-or-tenant`, `rs3-answer-login-sensitive-items`
- `rs3-answer-mfa-prompt-failing`
- `rs3-answer-recovery-before-change`, `rs3-answer-recovery-unclear-caller`
- `rs3-answer-network-symptom-note`, `rs3-answer-network-health-authorised`, `rs3-answer-network-settings-before-signoff`

Three were ranked second and were kept without replacement: `rs3-answer-mfa-disable-check` (rank 2, top score 0.647),
`rs3-answer-mfa-provider-outage` (rank 2, top score 0.707), `rs3-answer-recovery-named-requester` (rank 2, top score 0.646).

Spare `rs3-spare-recovery-description-not-proof` was also ranked first. The spares were not used for any primary that was kept.

### Result

- **Final kept answerable set: three questions.** Twelve unanswerable questions were kept as written.
- **Replacements made: none.** Every pre-assigned spare was ranked first, so none could replace its primary.
- **Top scores on unanswerable questions:** 0.466 to 0.567. None reached the 0.70 floor.

### What this means

- **This set cannot test ranking on this corpus.** Retrieval put the expected document first for nine of twelve questions, and
  for their spares too. Pre-writing spares did not help, because the spares were written in the same style and were just as
  easy. The result is not a fault in the protocol, but the set can't answer the question it was designed for.
- **The four-document corpus is too small to test ranking.** With four documents and distinct topics, the expected document
  is almost always first. The measurable ranking problem needs more competing documents.
- **The earlier, larger corpus is the place to look.** `docs/DEV-LARGE-RETRIEVAL-BENCHMARK.md` uses a 50-document development
  corpus, where vector MRR was 0.882. A ranking test would need the owner's decision to use that corpus, or to build a larger
  North corpus. It should be pre-registered.

Nothing is accepted or rejected here. The route stays on v4 and "not ready".
