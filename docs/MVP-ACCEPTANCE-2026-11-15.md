# Aegis AI — authenticated MVP acceptance evidence

**Acceptance date:** 2026-11-15

**Source baseline:** `ae5fe85768912aed1df1cd77164c4373e8c4746b`

**Scope:** local synthetic case viewing and human review. This record does not qualify grounded-AI quality or production readiness.

## Human-confirmed browser evidence

The operator confirmed real Auth0 login, Synthetic North case visibility, Synthetic South denial without case disclosure, permitted review-history access, and reader-only submission restrictions. After the approved North reader-to-operator membership update, Approve/Reject/Defer controls appeared. The operator then submitted one separately approved Defer review for `SYNTHETIC-LOGIN-001` and confirmed that the saved history remained visible after browser refresh.

The UI reported success. The exact HTTP response status was not captured. No token, password, subject value, or browser storage was collected for this record.

## Read-only database evidence

Read-only verification found exactly one review for the target synthetic North case. Its decision and note matched the approved submission; its actor matched the verified North operator membership; and a database-generated timestamp was present. Case status remained `in_progress`. The case, tenant, membership, audit-event, document, document-chunk, and migration-history fingerprints matched the pre-submission baseline. No duplicate review or unrelated membership change was found.

The review record is the persisted human-review evidence. A separate `audit_events` row was not part of the review contract and was not expected. The live request was not replayed; idempotency is supported by implementation and automated tests only.

## Live runtime evidence

At final read-only verification, the local API and Vite returned HTTP 200 on loopback. The restricted runtime database-role verifier passed. Migrations 001–006 were present and their recorded SHA-256 checksums matched repository SQL. Both AI feature flags remained false. No inference was executed for this acceptance.

## Automated evidence

The approved main commit has successful [GitHub Actions run 43682896006](https://github.com/AnkurSingh16/aegis-ai-architect-portfolio/actions/runs/43682896006) (`push`, `main`, head `ae5fe85768912aed1df1cd77164c4373e8c4746b`). Lint, typecheck, automated tests/coverage, mocked browser workflow tests, isolated PostgreSQL integration, build, whitespace validation, and Auth0 Terraform validation passed.

The browser CI tests mock Auth0 and API responses. They are not the real browser login described above. PostgreSQL CI tests use isolated disposable storage and do not mutate the local demonstration database.

## Source-inspection evidence

The reviewed implementation verifies JWT signature, issuer, audience, expiration and required scope; checks exact issuer/subject/tenant membership; and uses transaction-scoped tenant context with PostgreSQL RLS. Review creation requires `write:cases` and operator membership, constrains the decision and note, uses an idempotency UUID, and attributes actor/timestamp in the database. Runtime privileges are restricted; review rows cannot be rewritten or deleted by the application role.

These source properties plus automated integration tests support the stated design. They are not a live penetration test or production security certification.

## Qualification and limitations

- **AUTHENTICATED HUMAN-REVIEW MVP: ACCEPTED** for this local synthetic workflow.
- **GROUNDED AI LIVE QUALITY: NOT QUALIFIED.** No live model call was part of this acceptance. Historical synthetic evaluations contain contract failures and over-abstention; they do not establish production accuracy or semantic entailment.
- Retrieval uses PostgreSQL English full-text search, not vector search or pgvector.
- No customer data, customer deployment, production availability, performance benchmark, or business outcome is claimed.
- Future model evaluation requires a separate bounded plan, predeclared acceptance criteria, reviewed source, versioned report, and explicit inference authorization.
