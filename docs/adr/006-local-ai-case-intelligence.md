# ADR 006: Local AI-assisted case intelligence

## Status

Proposed for Milestone 3A review.

## Context

Aegis already verifies Auth0 RS256 access tokens, enforces `read:cases` scope and tenant membership, and uses PostgreSQL forced RLS. The stored case row contains a synthetic fixture identifier, status and timestamps; it does not store a customer narrative. The existing portfolio triage endpoint is deterministic mock output and must remain clearly separate from actual model inference.

## Decision

Add a development-only protected analysis endpoint using the existing JWT, membership and RLS path. It reads the case through the existing authenticated transaction and completes/releases that transaction before inference. The endpoint accepts no case text from the browser. The prompt contains only fields from the authorized stored row and matching source-controlled synthetic fixture metadata.

The first optional provider is local Ollama, contacted only at fixed `http://127.0.0.1:11434/api/generate`. Explicit server-side opt-in is required; configuration is disabled by default, rejected in production, and invalid settings fail closed. The app makes no cloud calls, no model downloads, no redirects, no retries and no synthetic fallback. A developer must install and run a model separately before enabling it.

Model output is untrusted strict JSON. The server accepts only fixed categories, priorities, teams, next actions, bounded rationale, confidence/uncertainty, allowlisted references to stored case fields and `humanReviewRequired: true`. Evidence references identify fields only; they are not RAG citations or external grounding. The API does not execute recommendations, change case status, send messages or initiate escalations.

## Security and resource controls

- Authorization and case read complete before provider invocation; rejected requests never reach Ollama.
- No arbitrary provider URL or client-supplied text is accepted. The endpoint uses loopback only and rejects redirects.
- Prompt/response bytes, generated tokens, timeout and concurrent inference are bounded; client disconnect aborts work.
- Provider errors return generic responses. Structured logs contain only provider/model labels, outcome, elapsed time and available token counts.
- React tokens remain in memory. Requests are same-origin and redirect-rejected; stale results are cancelled and cleared on tenant, identity or session changes.
- Local inference still consumes developer CPU/RAM and sends the limited synthetic prompt to the local Ollama process; timeout is at most 30 seconds and concurrency is at most two.

## Evaluation

Automated tests use synthetic fixtures, mocked provider responses and isolated PostgreSQL `aegis_test`. Self-constructed expected outputs exercise schema validation and fixture-reference wiring; they are not independent labels applied to model output and do not measure model quality or accuracy. Other tests check evidence-reference validity, invalid recommendation rejection, injection-like output rejection, tenant authorization, failure/timeout/cancellation and latency/token metadata parsing. Any future model-quality evaluation requires a separately approved inference run, independent evaluation cases, and recorded model/version, dataset and measured results.

## Human review and future providers

Every response requires human review. No AI output can trigger a write or action. A future cloud provider requires a separate decision covering tenant data egress, secrets, cost, retention, regional processing, model changes and equivalent cancellation/output controls; no such provider is implemented here.

## Consequences

The vertical slice proves a genuine local inference path without paid services or cloud egress while preserving deterministic CI. Its narrow synthetic context limits usefulness and prevents it from being mistaken for analysis of arbitrary customer narrative. Ollama availability, hardware resource use and model quality remain operator-dependent.
