# ADR 007: Tenant-scoped, evidence-grounded case intelligence

## Status

Accepted architecture direction; implementation is under review on `feat/m4-grounded-ai-intelligence`. The implementation branch adds synthetic-only ingestion and grounded retrieval. It is not merged or operationally deployed.

## Context

Milestone 3A established a development-only, local Ollama analysis path for synthetic stored cases. Its evidence references identify case fields and are not citations or external grounding. The next capability should answer from explicitly owned support documents while preserving Auth0 verification, membership checks, PostgreSQL forced row-level security (RLS), bounded inference, and human review. No cloud provider or data egress has been approved.

## Decision proposal

Build a local-first retrieval path with separate, reviewable stages:

1. Define a versioned synthetic document catalog and tenant-owned document/chunk metadata. Record source owner, tenant, document version, content hash, and ingestion provenance. Do not load real customer documents in the initial milestone.
2. Store document/chunk ownership in PostgreSQL with forced RLS and default-deny policies. Retrieval takes its tenant only from the server-verified membership transaction; neither request fields nor model output select a tenant.
3. Start with a bounded PostgreSQL full-text retrieval baseline, fixed top-k and size limits, and an explicit relevance threshold. This gives a deterministic, inspectable baseline without adding an embedding model or dependency. Evaluate pgvector only after a separately reviewed choice of a local embedding model and measured retrieval need.
4. Retrieve only authorized chunks in the existing authenticated transaction. Verify document ownership and version before returning a chunk. Release the database transaction before model inference; do not hold a connection during generation.
5. Assign opaque, request-scoped citation IDs to the retrieved chunk set. The model can return only those IDs. Server validation rejects unknown, duplicate, or unrequested citations. A citation proves association with a retrieved source, not that a generated claim is entailed by that source.
6. Treat all document text as untrusted instructions and content. Keep system instructions separate, state that retrieved text cannot change policy, bound and delimit snippets, and test malicious instructions embedded in documents. The model cannot issue SQL, select retrieval scope, or authorize access.
7. Require an explicit insufficient-evidence/abstention result when retrieval is empty, below threshold, or fails citation validation. Validate output strictly and keep recommendations advisory with mandatory human review. No automated case mutation, communication, or escalation is part of Milestone 4.
8. Evaluate retrieval and generation separately using versioned synthetic query/document pairs. Measure retrieval recall/ranking, citation validity, groundedness review outcomes, abstention, schema compliance, latency, and resource use with explicit denominators. Do not equate valid citations or schema compliance with factual correctness.
9. Record sanitized correlation, stage, duration, bounded token/resource measurements, and fixed failure categories. Never log prompts, document text, generated prose, credentials, or raw provider errors. Apply request, context, response, concurrency, timeout, and local-resource limits.
10. Keep Ollama as the only implemented inference provider until a separate data-egress, privacy, retention, regionality, security, cost, and operations decision approves any cloud provider.

## Authorization and transaction boundary

The Fastify route must reuse the existing verified Auth0 issuer/subject, `read:cases` scope, database membership and forced-RLS transaction. The case and retrieval rows are read under that same tenant authorization context. Authorization failures must not invoke retrieval or inference. Database transactions end before the provider call. Revocation semantics and the repeatable-read snapshot boundary must be documented and tested. A model response never establishes authorization.

## Evaluation and acceptance criteria

Milestone 4 may be considered complete only when all of the following are demonstrated in deterministic tests and a bounded, separately approved local evaluation:

- Synthetic document ownership, versioning, provenance, and tenant RLS are enforced; cross-tenant retrieval returns no content and does not invoke generation.
- Retrieval is bounded and deterministic for a fixed corpus/query, and reports its ranking and denominator. Full-text baseline is measured before any vector extension.
- Citation IDs are generated server-side per request and resolve only to the exact authorized retrieved set; unknown, duplicated, stale, cross-request, or cross-tenant citations fail closed.
- Empty/weak retrieval produces an explicit abstention; unsupported or malicious document instructions do not expand authorization or cause actions.
- Strict response validation, request correlation, sanitized diagnostics, cancellation, timeouts, response bounds, and mandatory human review remain in force.
- No case writes, message sending, or escalation can be triggered by model output.
- CI uses synthetic fixtures and mocks only, with isolated PostgreSQL integration tests; no cloud service, external AI call, production data, or paid resource is required.
- Evaluation records model/dataset/code identity, per-metric numerators and denominators, failures, latency/resource observations, and limitations. Small synthetic samples are not presented as production accuracy.
- Operational documentation covers data ownership, deletion/version behavior, incident response, resource limits, failure handling, and rollback of the new retrieval capability.

## Dependencies and implementation order

1. Review the threat model, data model, synthetic corpus, RLS ownership model, and migration rollback strategy.
2. Add schema/migrations and isolated integration tests for tenant-owned documents/chunks; do not alter existing migrations.
3. Implement ingestion of only the versioned synthetic catalog with provenance and content-integrity checks.
4. Implement bounded full-text retrieval behind the authenticated transaction and verify RLS isolation.
5. Add request-scoped citation construction and strict validation/abstention contracts.
6. Add local-only provider orchestration after the transaction closes, retaining current provider safety controls.
7. Add deterministic retrieval/groundedness contract tests and separately approved local evaluation.
8. Review operational metrics, resource cost, failure recovery, and documentation before considering any wider dataset or provider.

## Milestone 4.1 storage foundation

The first independently reviewable slice adds only `aegis.documents` and `aegis.document_chunks` through a new additive, checksummed migration. A document version is identified by `(tenant_id, source_identity, version)`; a new version is a new row, and chunks bind to the exact tenant, document ID, version, and source identity with a composite foreign key. Chunk positions are unique within a document version. Opaque UUIDs are storage identifiers, not authorization credentials.

Document rows carry bounded source-owner, fixed synthetic-catalog provenance, revision, metadata, and a lowercase SHA-256 source-content digest. Chunk content is bounded to 8 KiB and its SHA-256 is checked in PostgreSQL against the stored UTF-8 bytes. The document digest is shape-checked only because the original document bytes are not stored in this slice; future trusted ingestion must compute and verify it against the source bytes. Provenance columns describe administrator-supplied claims and do not independently prove ownership.

Both tables use enabled and forced RLS. Runtime SELECT policies require authenticated access mode, the matching transaction-local tenant, and the matching principal membership visible through the existing membership RLS policy. Fixture mode, missing/mismatched identity, and missing tenant context return no rows. `aegis_app` receives SELECT only on these tables; ingestion remains unavailable to the application role and outside this slice. No HTTP upload, document mutation, retrieval, vector index, or model call is introduced.

Migration 003 is applied transactionally by the existing migration runner, whose recorded checksum remains authoritative. Integration setup must validate both administrator and runtime connection targets as loopback `aegis_test` before fixture writes. This PR does not apply the migration to `aegis_local`. A failed migration transaction rolls back; schema rollback or removal of populated rows requires a separate reviewed migration and approval, not an automatic `DROP`.

The runtime-role verifier requires the six expected application tables, RLS enabled and forced, non-runtime ownership, expected SELECT privileges, and no document/chunk DML. It fails closed if an unexpected table appears in the application schema. The storage integration suite uses synthetic records inserted through its isolated administrator connection and checks cross-tenant reads, principal/tenant context, version/provenance foreign keys, integrity bounds, runtime privileges, migration replay, transaction snapshots, connection reuse, and concurrent tenant isolation.

## Risks and mitigations

- **Cross-tenant document leakage:** forced RLS, transaction-local tenant context, ownership checks, and adversarial isolated integration tests; no model-selected scope.
- **Prompt injection in documents:** treat retrieved text as untrusted data, constrain snippets, preserve policy hierarchy, validate all outputs, and test malicious documents.
- **False grounding:** citations prove source identity only. Require human review and groundedness evaluation; do not claim citation validity proves entailment.
- **Retrieval misses or ranking bias:** establish a full-text baseline, use explicit abstention thresholds, and report recall/ranking metrics before adopting embeddings.
- **Sensitive content in logs or model context:** synthetic-only initial corpus, local-only inference, bounded context, and sanitized observability. Any real-data or cloud use requires a separate approval.
- **Resource exhaustion and partial failure:** bound top-k, bytes, tokens, duration and concurrency; fail generically, avoid retries, and leave database state read-only.
- **Stale citations/document versions:** bind IDs to request and version; reject references outside the current retrieved set.

## Rollback and failure handling

Retrieval remains a read-only capability behind a development feature flag. On an RLS, ownership, citation, privacy, or unbounded-resource defect, disable the capability, preserve sanitized evidence, and investigate before resuming. Do not weaken RLS, accept unknown citations, automatically retry, mutate case state, or fall back to ungrounded model output. Database schema rollback must use a separately reviewed migration plan and must not delete existing case data.

## Consequences

This proposal favors explainable retrieval and strict ownership over early vector-search complexity. It establishes a measurable baseline and a path to embeddings without approving model downloads, external services, cloud inference, production data use, or automated support actions. Milestone 4 remains proposed until implementation and acceptance evidence exist.

## Implementation status (Milestone 4 branch)

The current Milestone 4 branch implements the source-controlled synthetic catalog, a guarded `aegis_ingest` role, additive ingestion/search migrations, English full-text retrieval, Auth0/RLS-backed grounded analysis, citation-ID validation/abstention contracts, and a development UI. This status describes source only: it is not merged, the new migrations have not been applied to `aegis_local`, the ingestion CLI has not been run, and no model inference has been authorized or performed in this milestone. Provider behavior is covered by mocks. The migration and integration suite are intended for the explicitly isolated `aegis_test` database and GitHub CI.

The project road map names Milestone 4 but does not define separate normative 4.2–4.6 acceptance boundaries. The branch groups the proposed sequence as catalog/ingestion, retrieval, citations/abstention, evaluation/security, and local orchestration/UI. That grouping is an implementation decomposition, not a claim that each sub-number was previously approved as a separately defined product requirement. See [ADR 008](008-grounded-document-ingestion-and-retrieval.md) for the implementation choices and limits.
