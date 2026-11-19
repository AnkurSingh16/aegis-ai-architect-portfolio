# AEGIS AI-Assisted Exploratory Evaluation V1

## Purpose and governance

This is a separate, synthetic, provider-level exploratory track. It is **not** the human-reviewed Grounded AI Qualification V1 contract and does not alter the accepted authenticated human-review MVP.

The frozen six-scenario dataset retains engineering-authored labels. External AI critiques have been reported, but neither independent human approval nor independently established ground truth has been verified. The dataset is answer-cued and small; agreement with its labels is not proof of correctness. This run cannot qualify production accuracy. Its report always states `qualificationStatus: NOT_QUALIFIED`, `humanApprovalStatus: NOT_VERIFIED`, and semantic evidence validation as `NOT_ASSESSED`.

This track measures machine-observable parser/schema, citation identity, human-review flag, label-comparison, latency, token, and failure outcomes descriptively; it does not issue a pass/fail qualification decision. It does not establish semantic entailment, taxonomy validity, retrieval quality, Auth0 authorization, database/RLS behavior, browser workflow, or production recommendation quality. Recommendations remain advisory; no case changes or external actions are invoked.

The runner deliberately does not read, parse, or create the human Qualification V1 reviewer manifest. Its report has a separate schema and an exclusive destination:

`.local/evaluations/ai-assisted-exploratory-grounded-qwen2.5-3b-instruct-v1.json`

An existing file blocks the run. The existing private writer reserves the report with exclusive creation and mode `0600`, under safe mode `0700` directories. Historical reports are untouched.

## Frozen dataset and provenance

- Dataset: existing `grounded-balanced-v1`, six fixed synthetic scenarios, three engineering-labeled `SUPPORTED` and three `INSUFFICIENT_EVIDENCE`, with thirteen distinct synthetic sources.
- Canonical digest: `6774f2b64c1d9e082529626420d94718209d387aa8b689ff69a03d0881b473bb`.
- Label provenance: engineering reviewed, externally AI-critiqued, **not human approved**.
- Model: `qwen2.5:3b-instruct`; expected local manifest digest `sha256:357c53fb659c5076de1d65ccb0b397446227b71a42be9d1603d46168015c9e4b`.
- Source provenance includes the synchronized execution commit/tree and the pinned protected source identities. The base release is `4c25c462adf1916af7ca0a41dc1a8092ac49d5f6`.
- The local runner pins the report/contract helper's SHA-256 after normalizing only the helper's exact `reviewedRunnerSha256` field; at runtime it compares this normalized hash for both local bytes and the helper blob at the approved release. The helper separately pins the runner's exact raw SHA-256. A missing or duplicate normalization field, altered helper content, mismatched release blob, runner mismatch, or missing approved-base ancestry fails closed.
- Runtime hashes do not prove independent code review or successful GitHub CI. Before a future run, an owner must independently verify the exact approved release, its PR review, and exact-head/main CI. The runner also requires local `main`, clean synchronized refs, immutable historical anchors, protected-file hashes, and the pinned exploratory runner blob. An operator-supplied SHA alone is not approval evidence.

### Owner-side trusted-launcher setup (not implemented)

**SOURCE TRUST: BLOCKED.** The code hashes are integrity checks, not a trusted approval root. Do not execute this runner until the owner has provisioned and independently approved a detached-signature launch path. No signing key, trust manifest, signature, or approval record is created by this preparation.

The future owner-controlled setup should:

1. Keep the Ed25519 private signing key offline under owner custody (for example, an offline hardware-backed key). It must never enter this repository, a Codex environment, CI secrets, shell history, or the evaluation host.
2. Provide a fixed owner-controlled launcher entry point (for example, `/usr/local/libexec/aegis-ai-assisted-exploratory-v1`) and verifier whose executable, configuration, trusted public key, revocation data, and parent directories are owned by an administrator and not writable by the evaluation account. The evaluation operator may invoke this entry point but may not replace its trust roots or verifier. Do not accept an arbitrary release SHA, manifest path, public key, or verifier from caller-controlled environment variables as evidence of approval.
3. Pin the corresponding public key and signature verifier outside the repository and outside paths writable by the evaluation account. Verify the key identifier, signature algorithm, revocation state, and validity/expiry policy before examining a manifest.
4. Have the owner sign a detached signature over a canonical, schema-versioned manifest. The manifest should bind the repository identity; approved release commit and tree; approved PR and exact-head/main CI run identities and successful required jobs; the exact runner SHA-256 and normalized contract-helper SHA-256; every protected evaluation/provider/parser/source/report dependency blob hash; dataset version and SHA-256; reported critique digests as unverified AI provenance; model tag and approved manifest digest; Ollama version; loopback endpoint; request, timeout, concurrency, retry, temperature and token settings; exact private report path; issue/expiry times; and a unique manifest/key identifier.
5. Validate the detached signature and strict manifest schema, then independently resolve the cited GitHub PR and CI evidence. Check that the release/tree and every listed Git blob match the immutable release, that the approved base is an ancestor, and that dataset/model/runtime/report settings exactly match this specification. Reject unknown fields, missing evidence, expired or revoked keys/manifests, mismatched hashes, duplicate/symlinked paths, and any ambiguity.
6. Execute the exact verified bytes from an immutable, read-only snapshot to close the hash-to-use race. Recheck the snapshot identity immediately before launch; keep the private report destination outside the snapshot and validate its parent permissions and absence with `lstat` before exclusive reservation. Do not execute a mutable checkout after verifying a different snapshot.

### Candidate manifest artifact inventory

The owner-approved manifest must enumerate every execution-critical artifact below by repository-relative path and the SHA-256 of its exact release blob. It must also include the resolved dependency-lock identity and hashes for the independently installed verifier and launcher. The list is a minimum inventory; the owner must re-audit imports before signing and add any newly reachable execution dependency. Hashes from this uncommitted worktree are provisional and are not signatures or approval evidence.

| Artifact | Why it is execution-critical |
| --- | --- |
| `apps/api/src/ai/evaluation/run-ai-assisted-exploratory-evaluation-v1-local.ts` | CLI gates, identity checks, model/runtime preflight, provider wiring, orchestration and report reservation. |
| `apps/api/src/ai/evaluation/ai-assisted-exploratory-evaluation-v1.ts` | Frozen contract, report schema, validation and report digest. |
| `apps/api/src/ai/evaluation/grounded-balanced-dataset.ts` | Six scenarios, evidence and frozen labels. |
| `apps/api/src/ai/evaluation/grounded-ai-qualification-v1.ts` and `source-identity.ts` | Reused historical release/source gate and protected-file identities. |
| `apps/api/src/ai/evaluation/grounded-balanced-runner.ts` and `grounded-balanced-scoring.ts` | Scenario scheduling, stop behavior, parsing outcomes and score derivation. |
| `apps/api/src/ai/grounded-provider.ts`, `grounded-analysis.ts`, and `analysis.ts` | Provider request construction, authoritative parser/schema, citation checks and safe failure outcomes. |
| `apps/api/src/ai/provider.ts` | Ollama endpoint and local model/runtime configuration contract. |
| `apps/api/src/ai/evaluation/ollama-socket-preflight.ts` and `run-grounded-supported-output-diagnostic-local.ts` | Connection isolation and proxy rejection helpers reused by the exploratory entry point. |
| `apps/api/src/ai/evaluation/private-report.ts` | Exclusive private report creation, write and close behavior. |
| `apps/api/src/ai/evaluation/grounded-provider-diagnostics.ts` | Bounded provider diagnostics persisted in the report. |
| `apps/api/package.json`, root `package.json`, and root lockfile | Entrypoint mapping and exact dependency resolution. |
| Relevant `.github/workflows/ci.yml` and workflow verification scripts | Evidence that the reviewed candidate's required checks ran on the exact PR head. |
| Installed launcher, verifier, trust-key file and revocation source | External trust root; these must be administrator-owned, independently hashed and not writable by the evaluation account. |

The owner must record the candidate's exact release commit/tree only after merge, and bind that release to the reviewed PR head plus successful exact-head and main CI evidence. No current commit represents this uncommitted candidate.

The current runner additionally requires a clean synchronized `main` checkout. That requirement must be reconciled with immutable-snapshot execution in a separately reviewed implementation before this owner-side launcher is considered usable; do not bypass either check. Until a trusted launcher, approved manifest/signature, and compatible verified-snapshot execution procedure exist, the evaluation remains blocked even if local source hashes match.

## Runtime boundary

A future, separately authorized run is bounded to:

- At most six provider invocations: one per scenario, sequential, concurrency one, no retry. A provider invocation can fail before an HTTP request reaches Ollama, so the report does not overstate provider-call counts as confirmed server-side generation counts.
- Per-request timeout 15 seconds, temperature `0.1`, `num_predict` `256`.
- Local Ollama only at `http://127.0.0.1:11434/api/generate`; no cloud fallback.
- Existing proxy rejection and Ollama socket/client isolation checks.
- Existing authoritative output parser and balanced evaluation runner.
- Interactive terminal confirmation, after source, dataset, model, and endpoint preflight.
- No API route, database, Auth0, or external action.

The report destination is reserved only after the explicit interactive confirmation. The report contains bounded per-case statuses, machine validation results and aggregate comparisons; it excludes prompts, case facts, source text, raw responses, model rationale, credentials, and reviewer identities.

## Interpretation

`completed_exploratory` means the bounded runner completed its planned provider attempts. It does not mean the model passed, the data is correct, or model quality is qualified. `incomplete` preserves a stopped/partial run. A process failure is reported with a bounded stage and the report path remains occupied to prevent retry/overwrite. Progress and final reports are written by `replacePrivateReportAtomically`: each update is flushed to a private temporary file in the report directory and renamed over the reserved path, then the directory is synced. A failure before the rename leaves the previous complete report in place and removes the temporary file. The reservation placeholder still blocks re-runs. This is rename-based replacement; `private-report-atomic.test.ts` injects faults at the filesystem boundary (temporary file creation, temporary `fsync`, `rename`, directory `fsync`) and checks that the previous complete report survives and no temporary file remains. A failed directory `fsync` happens after the commit point, so the new report is in place and the error reports unconfirmed durability. No test simulates power loss, so durability across a crash is a design property and not separately proven. Every report remains `NOT_QUALIFIED`, regardless of apparent agreement.

Expected source-identity coverage for supported outputs is a lookup check, not semantic entailment. The current scoring utility treats expected citation identity sets as empty for abstention labels; the report calls out that limitation rather than interpreting it as a failed semantic evidence test. Independent semantic review is still required before any stronger claim.

## Reported external AI critiques

Two AI-assisted critiques were reported for this dataset. Their frozen report digests are carried as provenance pointers in the exploratory report, with both citing the same dataset digest above:

| Reported model | Critique type | Report SHA-256 | Provenance status |
| --- | --- | --- | --- |
| Claude Sonnet 5.5 | Preliminary classification critique | `f3122a058024f6cb165e041a9782feb22b13b81034ebc3f888120545ccbbbe2d` | Reported AI critique; not human approval |
| GPT-6-family | Context-isolated blinded evidence critique | `d0cb6677cd0c08cbb520f3bc2ed8fe53137943a0b036fda4fbe96893dabef1e7` | Reported AI critique; not human approval |

The digests identify supplied private artifacts; the exploratory runner does not open or re-validate those artifacts. The reported critiques are not human reviewers, are not independent ground truth, and do not constitute AEGIS provider inference. The blind critique reportedly agreed on grounding states, while supported-category agreement was not established; the scenarios were also identified as strongly answer-cued. These are limitations, not validation claims.

## Future operator authorization

No inference is authorized by this document or the preparation work. Before any live request, require all of the following:

1. Independent owner verification of the exact merged source release, PR review, and passing exact-head and main CI.
2. A safe, exclusive Ollama window with no competing client, exact model digest/version, loopback listener, and no proxy configuration.
3. A safe private report parent and an absent destination.
4. A separate explicit authorization naming this exploratory track and its six-request ceiling.

The authenticated human-review MVP remains accepted. Grounded AI live quality remains **NOT QUALIFIED**.
