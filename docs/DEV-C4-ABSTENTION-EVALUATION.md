# C4 labelled abstention evaluation (development)

## What this measures
The self-correcting answer loop (`apps/api/src/rag/self-correcting-answer.ts`) over tenant-scoped lexical retrieval
(`rag/document-evidence.ts`) and the eight synthetic North documents, on 15 labelled questions. The generator is a
deterministic stub that cites the top evidence item. So this measures **answer and abstention decisions**, not the
quality of generated text. No model is in the path.

## Cases
Defined in `apps/api/src/rag/abstention-cases.ts` and written before the run. They were not tuned after seeing results.
- 8 answerable: each is supported by one North document. Questions paraphrase the document.
- 7 unanswerable: 4 off-topic, and 3 whose only support is in the South tenant, which the North reader cannot see.

## Result (real PostgreSQL 17, `maxRounds` 2, `minScore` 0.015)

| Measure | Value |
|---|---|
| Answer recall (correct source, all citations match) | 3 / 8 = 0.375 |
| Wrong-source answers | 0 |
| False abstentions (answerable, abstained) | 5 |
| False answers (unanswerable, answered) | 0 / 7 = 0 |
| Abstention precision (true abstentions / all abstentions) | 7 / 12 = 0.583 |

Correct answers: login-record, recovery-verify, network-note. Missed on paraphrase: login-scope, mfa-challenge, mfa-clock,
recovery-code, network-authz.

## What this supports and what it does not
- Supports: with lexical retrieval, the loop answers only when a North document matches the wording, and it did not
  answer any of the 7 unanswerable cases. Cross-tenant questions abstained.
- Does not support: any quality claim. 15 cases, one author, one run, engineer-written questions. The 0 false-answer
  rate is weak evidence, because the unanswerable cases share almost no vocabulary with the corpus.
- Main finding: recall on paraphrased questions is low (3 of 8). This matches the earlier lexical paraphrase measurement
  (`docs/DEV-RETRIEVAL-PARAPHRASE-MEASUREMENT.md`). The vector and hybrid paths are not connected to this loop yet.

## Reproduce
Set the isolated test URLs and role passwords as for the other integration tests, and set `C4_EVAL_OUTPUT` to a file path.
Then run `npm run test:integration -w apps/api` and read the report from that file.
