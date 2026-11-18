# Grounded AI Qualification V1

## Status

Preparation only. No model request is authorized by this document or by CI. The six-case smoke test is **not** a production-accuracy benchmark. The current grounded AI status remains **NOT QUALIFIED**. Dataset-label approval is **PENDING**.

The accepted authenticated human-review MVP is closed and is not part of this evaluation.

## What this evaluation measures

Qualification V1 reuses the frozen six-case synthetic dataset and the current grounded provider/parser/scorer. It supplies each case and its fixed synthetic evidence directly to the provider. It measures the model's natural choice between `SUPPORTED` and `INSUFFICIENT_EVIDENCE`, structured-contract acceptance, expected classification agreement, citation identity, and mandatory human review.

It does not exercise PostgreSQL full-text retrieval, the authenticated API, Auth0, tenant membership, RLS, browser behavior, or downstream support actions. It cannot establish production accuracy or semantic entailment by itself. Citation IDs identify supplied evidence; reviewers must separately decide whether the evidence entails each claim.

The production retrieval path uses PostgreSQL English full-text search. No vector database is used by this evaluation.

## Frozen smoke-test contract

| Setting | Frozen value |
| --- | --- |
| Model tag | `qwen2.5:3b-instruct` |
| Model manifest digest | `sha256:357c53fb659c5076de1d65ccb0b397446227b71a42be9d1603d46168015c9e4b` |
| Ollama version | `0.40.15` |
| Dataset | `aegis-grounded-balanced-v1`, six cases, thirteen unique synthetic sources |
| Expected cases | Three `SUPPORTED`; three `INSUFFICIENT_EVIDENCE` |
| Requests | At most six; one per scenario; sequential; concurrency one; zero retries |
| Timeout | 15,000 ms per request |
| Generation | Temperature `0.1`; existing provider budget `256` tokens |
| Endpoint | `http://127.0.0.1:11434/api/generate` only |
| Fallback/actions | No cloud fallback; no external or case-changing actions |

The runner must refuse a tag/digest or Ollama-version mismatch, a proxy configuration, non-loopback or competing Ollama connection, active generation, missing model, or unsafe report destination. Socket inspection is a point-in-time check and cannot atomically prevent another same-host client from connecting between checks; the owner must establish an exclusive Ollama window, and any observed competing client blocks execution. A failure is recorded as a failure/inconclusive run; no scenario is retried. Invalid structured outputs may be recorded while later distinct scenarios are attempted, but the same scenario is never retried. A provider/transport/timeout failure stops further attempts.

## Source identity and release gate

The verifier requires clean `main`, a fetched `origin/main`, an explicitly supplied expected release SHA, and equality of that SHA with local `HEAD`, local `origin/main`, and the live remote `main`. It requires ancestry from approved baseline `b383413d7874665b9056f80753d12b000f5fe5b9`, the approved M4.22/M4.23 release commits, and immutable SHA-256 checks for evaluation-critical files. The M4.22 source-gate anchor is pinned to reviewed PR #63 commit `bb94ed7ae47da6bf5119674beaf82ea0f6ddc59b` and its reviewed runner content; the verifier must not trust a feature-branch tip as the trust root.

The squash SHA for this preparation PR is not known in advance. Before any future run, an operator must independently verify the merged commit and its exact-head CI, then pass that exact commit as the expected release SHA. The runtime verifier does not prove that GitHub CI passed; that remains an external release approval gate. Any unrecognized release SHA, missing baseline object, changed protected file, dirty tree, remote mismatch, or wrong branch fails closed.

Protected identities cover the frozen balanced evaluator dependencies, the new Qualification V1 CLI runner, provider configuration and implementation, output schema/parser, retrieval contract, private report writer, socket preflight, and immutable source-gate anchor. The Qualification V1 verifier is itself part of the reviewed source release: because it cannot contain a non-self-referential hash of its own bytes, its trust comes from the independently verified exact-head PR CI and exact merged release SHA, not a runtime self-hash. That external release approval is mandatory and is not inferred from a caller-supplied SHA. Later unrelated approved files do not invalidate the run, but changing any blob-pinned dependency or CLI runner requires a reviewed source-identity update.

## Dataset review checklist — pending

The current labels are engineering-reviewed, not independently human-approved. Two reviewers must complete the checklist separately, without seeing model output, prior model scores, or each other's verdicts. Reviewers examine the case facts, every supplied source, expected grounding state, expected classifications/actions, expected citation identities, and whether abstention is correct. They mark each expected field as entailed, unsupported, contradicted, or not applicable. Any disagreement is adjudicated before freezing the dataset; unresolved disagreement blocks evaluation. Model predictions must never be used to change labels.

| Scenario | Expected state | Reviewer A | Reviewer B | Adjudication |
| --- | --- | --- | --- | --- |
| `BALANCED-LOGIN-201` | SUPPORTED | PENDING | PENDING | PENDING |
| `BALANCED-LOGIN-202` | INSUFFICIENT_EVIDENCE | PENDING | PENDING | PENDING |
| `BALANCED-BILLING-301` | SUPPORTED | PENDING | PENDING | PENDING |
| `BALANCED-BILLING-302` | INSUFFICIENT_EVIDENCE | PENDING | PENDING | PENDING |
| `BALANCED-GUIDANCE-401` | SUPPORTED | PENDING | PENDING | PENDING |
| `BALANCED-GUIDANCE-402` | INSUFFICIENT_EVIDENCE | PENDING | PENDING | PENDING |

The future runner requires a private `.local/operator/grounded-ai-qualification-v1-dataset-review.json` manifest. It records the exact dataset SHA-256, two distinct pseudonymous reviewer IDs, and, for every scenario, the expected grounding state, each applicable classification-field judgment, expected source identities, and whether abstention is justified. Both reviewers must approve all six cases, and the top-level adjudication records their claim of approval. The manifest must be a regular non-symlink mode-0600 file under a genuine mode-0700 directory. It must not include credentials, account subjects, source text, or customer information. **This local manifest is not proof of reviewer identity, independence, or approval**; those claims require owner verification against separately obtained review evidence before any future inference authorization. The runner records the manifest as an attestation only and keeps independent approval unverified. No manifest or approval is created by this PR; the prerequisite remains PENDING.

## Predeclared smoke-test gates

All gates are required for a smoke-test pass:

1. Six of six scenarios have a completed request and response; attempted and completed counts are reported separately.
2. Six of six responses parse as JSON and pass both the approved schema and authoritative application parser.
3. `humanReviewRequired` is true for all six accepted outputs.
4. All three expected-supported cases are naturally `SUPPORTED`; all three expected-insufficient cases abstain.
5. There are zero false-supported outputs.
6. Every supported output has finite numeric confidence in `[0,1]`, one or more unique citations, and every citation resolves only to that scenario's supplied sources and expected source identities.
7. Supported category, priority, team, and action match independently approved labels.
8. Both independent reviewers judge every substantive supported claim entailed by its cited evidence. Citation identity alone is insufficient.
9. There are no retries, hidden repeated requests, timeouts, transport failures, incomplete scenarios, or unsafe provider states.

Any false-supported result, invalid citation, reviewer disagreement, or contract failure is a failed smoke test. An interruption, timeout, transport error, or incomplete set is inconclusive and must not be rerun under the same authorization. This runner records completed model outcomes as pending independent semantic review; it does not provide a post-run semantic-review workflow or claim final qualification. Passing these machine-checkable smoke gates allows consideration of a separately reviewed semantic and larger evaluation only; it does not qualify production accuracy.

## Private report and provenance

The only intended report destination is:

`.local/evaluations/grounded-ai-qualification-qwen2.5-3b-instruct-v1.json`

It must be absent before a separately authorized run. The runner reserves it exclusively through the existing private writer, under a genuine mode-0700 private directory and mode-0600 report file. Existing paths, symlinks, unsafe directories, or permissions block the run. Historical reports are never overwritten.

The report records the exact execution commit/tree and protected SHA-256 values, dataset version/digest and label provenance, model tag/manifest digest, Ollama version, prompt-template source digest, frozen settings, UTC start/end, bounded per-case outcomes, aggregate metrics, stop/failure classifications, and limitations. It distinguishes a submitted reviewer manifest from independently verified approval. It does not store prompts, case facts, source text, rationale text, model responses, authentication tokens, or credentials. Numeric token-usage counts may be reported; token contents may not.

The report-integrity digest is SHA-256 over canonical JSON of the completed report with the digest field omitted. It is deterministic and non-self-referential; it can be recomputed from the private report. In-progress reports are preserved after interruption and never replaced. The first report remains `INCONCLUSIVE` pending semantic review. Any later reviewer sign-off must be a separate private artifact bound to the report digest; it must not rewrite the original report.

## Larger evaluation required for stronger claims

Six authored synthetic cases are a smoke test, not a generalizable benchmark. A later blinded holdout should broaden source types, tenants, paraphrases, conflicting evidence, prompt-injection content, and evidence-absent cases. As a rough rule-of-three guide, zero false-supported outcomes in 60 independent insufficient-evidence examples gives an approximate one-sided 95% upper bound of 5%; about 300 would be needed for roughly 1%. These bounds require genuinely independent, representative scenarios and do not make the system production-ready.

## Future execution approval

Live inference requires a separate explicit owner authorization after this PR is merged and its exact-head CI passes, the dataset review is complete and frozen, the release SHA is verified, the report path is absent, and an exclusive local Ollama window is established. The operator must personally confirm in a real TTY. No API flags are changed and no authenticated API, database, migration, or review workflow is invoked.

The planned command is process-local to the evaluation CLI; these values must not be applied to the already-running API:

```sh
NODE_ENV=development \
AEGIS_AI_ENABLED=true \
AEGIS_GROUNDED_AI_ENABLED=true \
AEGIS_OLLAMA_MODEL=qwen2.5:3b-instruct \
AEGIS_AI_TIMEOUT_MS=15000 \
AEGIS_AI_MAX_CONCURRENT=1 \
AEGIS_GROUNDED_QUALIFICATION_RELEASE_SHA=<independently-verified-main-sha> \
npm run ai:evaluate:grounded:qualification-v1:local -w apps/api
```

The release SHA is not trusted merely because it is supplied to the command. Before entering it, the operator must independently verify the exact merged main commit, its ancestry and protected source identities, and successful automatic main-push CI for that exact SHA. The CLI then checks local `HEAD`, fetched `origin/main`, and the live remote main against that identity. Any mismatch blocks execution. The command is documentation only and was not run for this PR.
