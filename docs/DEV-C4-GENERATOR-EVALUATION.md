# C4 live generator evaluation (pre-registered, not yet run)

Recorded before any run. No score from this set has been seen.

## Question

When the live generator (`apps/api/src/rag/ollama-generator.ts`) runs inside the answer loop, with vector retrieval and the
owner's similarity floor, does it answer the answerable questions with a correct citation, and does it abstain on the
unanswerable ones? This measures decisions after the output guard. It does not measure the quality of answer text.

## Fixed inputs

- **Set:** `generatorEvalCases` in `apps/api/src/rag/generator-cases.ts`. Twelve answerable (three per North document)
  and twelve unanswerable (six off-topic, six South-domain). The set is fresh: a unit test checks that no question repeats
  any earlier calibration or holdout set.
- **Retrieval:** vector retrieval over the North tenant, embeddings from `nomic-embed-text` (digest pinned), top 5.
- **Floor:** 0.70, the owner's decision in `docs/DEV-C4-FLOOR-CALIBRATION.md`. It is not tuned here.
- **Loop policy:** `maxRounds: 2`, `minScore: 0.70`, `forbiddenSubstrings: ['SENTINEL-XYZ']`. Same as the other evaluations.
- **Generator:** `createOllamaGenerator()`, model `qwen2.5:3b-instruct`, digest pinned in the module. Decoding is deterministic.
- **Scoring:** the existing scorer (`scoreAbstentionCases`). A correct answer is an answer whose every citation equals the
  expected source. A false answer is any answer on an unanswerable case.

## Reported

- Answer recall, wrong-source answers, false answers and abstention precision, from the scorer, with the counts.
- Generation failures (the generator threw), counted separately. A failure is not counted as an abstention or an answer,
  and it is reported on its own line.
- Guard rejections, if the loop reports them, counted per case and reported as they are.
- Per-case outcomes with the top retrieval score, so a result can be read against the floor.

## Run rules

- **One run**, through the real loop, on this set. A second run would be a second look and is not allowed.
- **No changes after the run.** The prompt, model, floor, policy and set are fixed. If the result is poor, it is reported as
  it is. A new prompt or model needs a new pre-registered set.
- **Stop condition.** The counts are the result. A false answer on an unanswerable case means the generator is not
  accepted for answering in this corpus. It does not change the floor.
- **Gating.** The run needs `AEGIS_LIVE_OLLAMA=1` and the loopback embedding and chat services. It is not part of the
  non-live suite.

## Known limits

- One author, the same as earlier sets. Not independent.
- Twelve answerable questions move recall by about 8 points each.
- Citation correctness is checked. Whether the statements in the answer are true to the document is not measured.
- The corpus is synthetic and small, so these results do not transfer to other corpora.

## Result (one run, as pre-registered)

Run once through the real loop: vector retrieval, floor 0.70, `qwen2.5:3b-instruct`, `maxRounds: 2`, `reformulate` returns
null. All 24 cases completed. No generation failures.

- **Answer recall:** 4 of 12 (0.333). **Wrong-source answers:** 0. **False answers:** 0 of 12.
- **Abstention precision:** 0.60 (12 true abstentions, 8 false abstentions).
- The 4 correct answers: `gen-answer-login-account`, `gen-answer-recovery-before-edit`, `gen-answer-recovery-unclear`,
  `gen-answer-network-posture`.

**Where the 8 answerable misses came from** (from the per-case records):
- **Below the floor, retrieval never reached the generator (5 cases):** `gen-answer-login-no-secrets` 0.673,
  `gen-answer-mfa-device-setting` 0.687, `gen-answer-mfa-reference-page` 0.687, `gen-answer-recovery-session-token` 0.683,
  `gen-answer-network-note` 0.662. These are the same floor effect as the holdouts, not a generator effect.
- **Generated without a citation, then abstained (3 cases):** `gen-answer-login-timeline`, `gen-answer-mfa-no-factor-removal`,
  `gen-answer-network-health-proof`. The output guard rejected each for `no_citation`. With reformulation disabled, the
  loop abstained after round 1. These cases pass the floor, so the generator's citation format is the cause.

**What this does and does not show:** the live generator, with this prompt, never cited a wrong source and never answered an
unanswerable question. Its recall was low, mostly because of the floor and partly because it sometimes omitted citations. The
citation failures are a real generator issue. A fix, such as a stricter prompt or allowing a second round, is a change to
the protocol and needs a new pre-registered set before any further run. This run is not repeated.

The report and per-case answers are kept in the scratchpad (`c4-generator-run1.json`), not in the repository.
