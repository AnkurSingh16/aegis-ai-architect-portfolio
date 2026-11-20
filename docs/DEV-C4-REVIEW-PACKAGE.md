# C4 review package: changes since the v8 owner review (branch c4-answer-quality-v8-review)

Scope: development work only. No live model run. The answer route stays on prompt v5 as the development configuration. It is
not for production promotion. The 0.70 floor is unchanged. Historical v8 results and review decisions are unchanged.

## Commits (oldest first, since f81d190)

| Commit | What it does |
| --- | --- |
| `9b1a72a` | Question-echo v2 (development only) and its protocol, recorded before any evaluation |
| `a88ec12` | Report-only verbatim-copy measure; Wilson intervals; guard lists each cited source once |
| `a76d73f` | Independent evaluation kit (materials only) and the set validator |
| `afc9a18` | Answer-quality gap assessment; retrieval investigation from existing records |
| (this commit) | This review package |

Earlier in the branch: `38dffc9` (echo v1), `f81d190` (echo v1 tests, route and floor decisions, first independent brief).

## Behaviour changes

1. **Citation list (route response).** `citations` now lists each cited source once, in first-cited order. Every citation is
   still checked against the allowed sources. The answer loop's `no_citation` decision depends only on the list being
   non-empty, so its decisions are unchanged. This is the only change that reaches the route's responses.
2. Nothing else reaches the route. Echo v2, the copy measure, the Wilson helper and the validator are not called by the route.

## What was not changed

- The route prompt (v5), the floor (0.70), the answer policy, the answer-text guard, and the echo v1 check.
- The v8 set, its results and the owner's review decisions.
- The live evaluation runner (no adapter for an independent set has been added).

## Tests (run on this commit's tree)

- `apps/api` unit tests: 95 files, 936 tests, passed.
- `apps/api` integration tests against a disposable PostgreSQL 17 container with CI-style credentials, no live model:
  11 files and 124 tests passed; 9 files (10 tests) skipped because they need `AEGIS_LIVE_OLLAMA=1`. Container removed.
- Root `npm run typecheck`: exit 0. Root `npm run lint`: exit 0.
- Not run: the root `npm test` suites for infrastructure scripts (`infra/terraform/...`, `apps/api/scripts/...`), which this
  work does not touch.

Specific new tests: echo v2 (16 tests: v8 regression, short answers, restatements, paraphrased question-only answers,
punctuation, negation, empty text, a known false positive, known limits); copy measure (6); Wilson interval (4); guard
de-duplication (2 added); independent-set validator (12).

## Known limits of what was built

- **Echo v2:** catches question-only answers and restatements made of question words. It does not catch paraphrased
  statement echoes that add new words, and it flags a real instruction whose words all come from the question. Both are
  tested as limits. It is not evaluated.
- **Copy measure:** reports only. The 12-word reporting threshold is chosen, not measured.
- **Validator:** checks shape, counts, mix and uniqueness. It cannot check independence or quality.
- **Kit:** no corpus, questions, labels or reviews exist. The authors and reviewer are not yet available.

## Open items, each needing the owner or an independent person

1. Independent corpus, questions and labels, to the kit's minimums (40 and 40 in the final holdout; 20 and 20 in
   calibration). Needs people outside this pipeline.
2. Human review sheets for the answered items. Needs a reviewer who is not an AI agent.
3. An adapter that reads the locked, validated set into the evaluation runner. Not built; it is a reviewed code change
   before any live run.
4. Echo v2 evaluation on a labelled set, and a decision on wiring it. Needs owner authorisation for the live run.
5. Any retrieval change (query reformulation, reranking, chunking, score normalisation). Each needs its own rationale and
   evaluation; none is adopted. See `docs/DEV-C4-RETRIEVAL-INVESTIGATION.md`.
6. Any prompt change for completeness or copying. A candidate needs its own protocol and separate authorisation for a live
   run. See `docs/DEV-C4-ANSWER-QUALITY-ASSESSMENT.md`.
7. The C4 register row should be updated once the kit is used. It is not updated in this package.

## Requirements for C4 completion (not yet met)

- An independently authored, independently reviewed evaluation meeting the kit's minimums, run once on a locked holdout.
- Human-validated responsiveness, completeness, support and echo rates with intervals.
- The owner's acceptance of the stated rates.
- Until then the answer route is development-only and the 0.70 floor is an owner-approved conservative threshold.
