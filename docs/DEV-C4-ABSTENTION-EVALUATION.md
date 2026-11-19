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

## Vector retrieval (live local embeddings, same 15 cases)
Wired through `rag/document-evidence.ts` (`vectorEvidenceRetriever`): the query is embedded with the local loopback
`nomic-embed-text` model (pinned digest), the nearest chunks are read under the tenant's row-level security, and the
score is cosine similarity. The similarity floor **0.5 was declared before the first live run** and not changed
afterwards. Gated by `AEGIS_LIVE_OLLAMA=1`, so the default test run does not need the embedding service.

| Measure | Lexical (earlier) | Vector, floor 0.5 |
|---|---|---|
| Answer recall | 3 / 8 = 0.375 | 8 / 8 = 1.0 |
| Wrong-source answers | 0 | 0 |
| False abstentions | 5 | 0 |
| False answers on unanswerable | 0 / 7 | 4 / 7 = 0.571 |
| Abstention precision | 7 / 12 = 0.583 | 3 / 3 = 1.0 (3 abstentions, all correct) |

Top similarity per case (first round):
- Answerable: 0.673 to 0.838.
- Unanswerable: 0.463 to 0.663. Four of seven were answered, with top similarity 0.589 to 0.663. Those four were the
  off-topic physics question and the three cross-tenant questions. Each citation named a North document; none named a
  South one, so tenant isolation held.

What this supports: at floor 0.5, vector retrieval answers more of the labelled answerable questions than lexical
retrieval, and it answers more unanswerable ones.

What this does not support: any choice of floor. The answerable and unanswerable similarity ranges overlap around
0.66 to 0.67. A floor near 0.67 would separate this set, but choosing it from these labels would be tuning on the
evaluation, so it is not reported as a result. A floor needs a separate labelled set, or the decision goes to the owner.
