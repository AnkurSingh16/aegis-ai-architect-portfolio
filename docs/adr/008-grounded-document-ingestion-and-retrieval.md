# ADR 008: Synthetic document ingestion and grounded local analysis

## Status

Proposed implementation on `feat/m4-grounded-ai-intelligence`; not merged or operationally deployed. Migrations 004 and 005 are additive and must be applied only through the reviewed migration runner. No local development migration or inference was performed as part of this work.

## Context

Milestone 4.1 provides tenant-owned documents and chunks with forced RLS. The project needs a bounded way to load only invented source-controlled support guidance, retrieve relevant chunks under the existing Auth0/membership boundary, and present source associations without overstating their meaning. The roadmap does not define sub-milestones 4.2–4.6 as separate normative scopes; the sequence below is the implementation decomposition used for review.

## Decisions

### Corpus and ingestion

- Keep eight invented support documents in a versioned TypeScript catalog, with stable source IDs, one explicit version, a fixed source owner, revision, UTF-8 SHA-256, title metadata and synthetic-only provenance.
- Validate all catalog bytes and metadata before connecting. Split by Unicode code point at a stable UTF-8 bound, preserve exact canonical NFC content, and hash each chunk.
- The CLI defaults to a no-database dry run. Existing `--apply` remains limited to a separate `DOCUMENT_INGEST_DATABASE_URL` for loopback `aegis_test` as `aegis_ingest`. A distinct, more restrictive `--apply-local` path additionally requires `AEGIS_LOCAL_DOCUMENT_INGEST_ENABLED=true`, a real TTY phrase naming `aegis_local`, and `DOCUMENT_INGEST_LOCAL_DATABASE_URL` for `127.0.0.1:5432/aegis_local` as `aegis_ingest`. Before and after confirmation it checks `DATABASE_ADMIN_URL` in a read-only transaction, the approved Docker Desktop cluster identifier, PostgreSQL server address/port against an explicit `docker --context desktop-linux inspect` of the healthy named container and its loopback port mapping. It refuses `aegis_test`, Colima, or any mismatched identity before opening the writer pool. The local path was implemented but not executed; it still requires a separately authorized migration/role readiness procedure. Both write paths use one transaction, parameters, and no overwrite/delete behavior. Identical source/version content is a no-op; conflicts fail closed.
- Migration 004 provisions a distinct non-superuser, non-BYPASSRLS, non-inheriting, non-creator login only when that migration is pending. Its grants are SELECT/INSERT on the two document tables only. RLS requires a transaction-local ingestion mode/tenant and hard-coded source-to-tenant allowlists. This credential can process the approved synthetic catalog across both synthetic tenants; it is not the HTTP runtime identity and is not suitable for untrusted upload traffic. Keep its credential private and separate from `aegis_app`.
- `aegis_app` retains SELECT-only document/chunk privileges. No browser upload endpoint exists. No document or case deletion/replacement behavior is added.

### Retrieval and grounded analysis

- Migration 005 adds an English `tsvector` generated column and GIN index. Queries normalize Unicode/whitespace, use fixed `plainto_tsquery('english')`, enforce query/result/context/time bounds and deterministic rank/source/version/position/UUID ordering.
- The protected grounded route requires the existing signed `read:cases` access token, membership and forced-RLS tenant context. It reads the case and matching documents in the same repeatable-read transaction, commits and releases the connection before invoking a provider. Browser/model tenant identity never authorizes access.
- The server generates random request-scoped citation UUIDs only for retrieved chunks. Output citations must be unique and present in that request's retrieved set. The response resolves them back to stable source ID/version/title and bounded excerpt, without exposing database chunk identifiers.
- Empty retrieval returns a fixed `INSUFFICIENT_EVIDENCE` response without inference. Supported output uses a fixed schema, enums, bounded rationale, citations, uncertainty and mandatory `humanReviewRequired: true`. Citation validity proves only that a chunk was retrieved; it does not prove entailment. Recommendations are advisory and cannot modify cases, message users or escalate.
- The local provider exists only behind both development-only `AEGIS_AI_ENABLED=true` and `AEGIS_GROUNDED_AI_ENABLED=true`; it uses fixed loopback Ollama, the existing model configuration/timeout/concurrency, bounded prompt and response, one request/no retry, cancellation, safe metrics and generic errors. Production is not supported and cloud inference is not implemented.

## Security and operational boundaries

Documents are untrusted content, never policy instructions. Prompts identify source text as untrusted and prohibit tools/actions/disclosure. Strict output validation, citation allowlisting, human review and tenant authorization remain server-owned. The model receives only the authorized case fixture/type, status, and bounded retrieved chunks after the database transaction ends. Logs contain fixed event/provider/model/stage values and bounded numeric measurements only; no source text, prompt, rationale, response or credentials.

The RLS GUC is set by trusted code and is not a stand-alone authentication mechanism. Runtime RLS also requires verified membership. The ingestion role is a separate privileged local tool credential scoped to exact synthetic source IDs and tenants, but it can process both tenants' fixed corpus; do not expose that credential to an HTTP path or external caller. Database administrators remain trusted and can bypass RLS.

## Evaluation and limitations

Unit tests use mocks only. The retrieval labels are engineering-reviewed synthetic query/source associations and cannot establish semantic relevance or production accuracy. A separate nine-scenario priority regression rubric preserves the earlier Milestone 3B finding of only 2/6 priority agreement; these labels are also engineering-reviewed, not independent human ground truth. Real model behavior, Ollama JSON Schema compatibility, semantic groundedness, latency under load, and production resource use remain unverified. No live inference is authorized by this implementation task.

## Migration and rollback

Migrations 004 and 005 are append-only and checksum-controlled. Migration 004 creates only policies/grants for the dedicated ingestion role; migration 005 adds the generated search vector and index. The migration runner applies them transactionally. If migration application fails, do not retry blindly, edit history, or drop populated objects. Keep the feature flag off, preserve diagnostics, and use a separately reviewed corrective migration. Disable grounded analysis by leaving `AEGIS_GROUNDED_AI_ENABLED` unset/false. No automatic rollback or document deletion is provided.

## Consequences

This establishes a local-first, auditable FTS and citation-validation baseline without embeddings, cloud services, arbitrary uploads, or automated actions. It does not qualify model quality or production readiness. Broader corpus ingestion, vector retrieval, semantic groundedness review, non-synthetic data, and any cloud provider require separate architecture, privacy, security and operational approval.
