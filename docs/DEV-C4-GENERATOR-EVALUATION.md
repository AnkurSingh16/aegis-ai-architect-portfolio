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
