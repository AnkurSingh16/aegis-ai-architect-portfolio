# F3 authority inventory (Phase B1, step 2, evidence-first)

Status: **static inventory from the migration sources at `0cb778a`**. It is not a live catalogue dump. No PostgreSQL was reachable locally,
so it does not establish what the database holds. The CI baseline (`apps/api/src/security/f3-baseline.integration.test.ts`) and a catalogue
dump in a later step are the runtime evidence. Read this as a map of where to look, plus one confirmed finding.

Method: every `CREATE POLICY` and `ALTER POLICY` statement in `apps/api/db/migrations/001`–`026` was parsed. The 80 statements that read
`aegis.access_mode`, `aegis.principal_issuer`, `aegis.principal_subject` or `aegis.tenant_id` are listed. Later `ALTER`s on a policy are
included in file order, so the list reflects the statements in order, not necessarily the final `USING` text of each policy. Confirm any
single policy against `pg_policies` before relying on it.

## Trust classes of the predicates

| Class | Predicate basis | Meaning under T1 |
|---|---|---|
| A. Tenant existence | `tenant_id = aegis.tenant_id` AND `access_mode = 'authenticated'` AND `EXISTS (membership in that tenant, any principal)` | **Not principal-bound.** Any caller that sets a tenant with at least one member reads it. |
| B. Principal-bound | membership join on `issuer`/`subject` taken from `aegis.principal_*` | Bound to a session value, which is caller-controlled. Forgeable under T1. |
| C. Tenant only | `tenant_id = aegis.tenant_id` with no membership at all | Caller-controlled tenant with no authority check. |
| D. Mode gate | `access_mode` alone selects the branch | Caller-controlled. |
| E. Workload roles | policies `TO` a workload role, using `aegis.tenant_id` | The login identifies the workload; the tenant is a session value. |

## aegis_app (application runtime login), effective after migration 020

| Table | Policy | Class | Settings read |
|---|---|---|---|
| `aegis.support_cases` | `case_scope` (020) | **A** | access_mode, tenant_id |
| `aegis.tenants` | `tenant_scope` (020) | **A** | access_mode, tenant_id |
| `aegis.audit_events` | `audit_scope` (020) | **A** | access_mode, tenant_id |
| `aegis.memberships` | `principal_memberships` (002) | B | access_mode, principal_issuer, principal_subject |
| `aegis.documents` | `document_membership_read` (003) | B | access_mode, principal, tenant_id |
| `aegis.document_chunks` | `document_chunk_membership_read` (003) | B | access_mode, principal, tenant_id |
| `aegis.case_reviews` | `case_review_read`, `case_review_operator_write` (006) | B | access_mode, principal, tenant_id |
| `aegis.tool_approvals` | `tool_approval_tenant_read/insert/update` (007) | C | tenant_id |
| `aegis.workflow_executions`, `aegis.workflow_checkpoints` | `workflow_*_tenant_*` (008) | C | tenant_id |
| `aegis.chunk_embeddings` | `chunk_embedding_tenant_read/insert` (009) | C | tenant_id |
| `aegis.rate_limit_buckets` | `rate_limit_buckets_tenant` (013) | C (no TO clause: all roles) | tenant_id |

**Finding (confirmed by source reading, reproduced in baseline B1, B2, B4, B5 once CI runs):** `support_cases`, `tenants` and `audit_events`
are class A. The verified principal is not part of their predicate, so the existing F3 claim about "membership policies" understates the
exposure: the **case** table is reachable with a tenant setting alone, as long as that tenant has any member. The existing fixture-boundary
test passes only because its target tenant has no membership row. The tenant-only control in
`fixture-boundary.integration.test.ts` (around lines 96–100) is therefore not evidence of tenant binding.

## aegis_gateway (investigation gateway login)

| Table | Policy | Class | Notes |
|---|---|---|---|
| `aegis.memberships` | `membership_gateway_read` (018) | **unconditional** `USING (true)` | Every membership row, every tenant. Baseline B3. |
| `aegis.investigation_requests` | `investigation_request_tenant_read`, `..._gateway_insert` (018) | E | tenant_id session value |
| `aegis.investigation_results` | `investigation_result_tenant_read` (018) | E | tenant_id session value |
| `aegis.agent_executions` | `agent_execution_gateway_cancel` (018), column grant on `cancel_requested`, `cancel_reason`, `version`, `updated_at` | E | the gateway may set the cancellation flag only |

Gateway access to the execution row is tenant-scoped by a session value. The principal check that makes the gateway safe is an
application-side `principal_ref` comparison (`src/investigation/gateway.ts`), not a database predicate.

## aegis_fixture, aegis_ingest, aegis_operator, participant roles

- `aegis_fixture` (020): `fixture_*_scope` policies, class D (`access_mode = 'fixture'`). Development persistence only. It must not be an
  alternative route to authenticated customer data. Under T1 the mode is caller-controlled, so the role itself must be what is protected,
  not the mode value.
- `aegis_ingest` (004): `document_catalog_ingest_*` and `document_chunk_catalog_ingest_*`, class D (`access_mode = 'catalog_ingestion'`). This
  is open finding F7. The login sets its own mode.
- `aegis_operator` (018): outbox requeue, read and purge, and message events, all on `tenant_id` (class E).
- Participants (`aegis_orchestrator`, `aegis_triage`, `aegis_retrieval`, `aegis_reviewer`): agent, grant and inbox policies on `tenant_id`
  (classes E), plus `document_retrieval_participant` (018) for `aegis_retrieval`. This is open finding F4 and section 5 item 1 of the
  boundaries document: the tenant is application-trusted.

## Other settings that gate behaviour

- `aegis.tenant_id` is read by every class A, C and E predicate. Workflow tenant runners (`src/workflow/workflow-routes.ts`, `tenantRunner`)
  set `aegis.tenant_id` **without** setting `access_mode` or a principal. Which login those routes use, and what they can reach, is an open
  inspection item for step 10 of Phase B1.
- Triggers that read session values: `aegis.principal_*` and `aegis.access_mode` in migration 006 (case review audit trigger) take the
  actor from the session. Those values are caller-controlled, so the audit actor is forgeable under T1.

## Items inspected, not yet mapped

- Exact effective `USING` text after every `ALTER POLICY` (requires `pg_policies` dump).
- Other tables created after migration 026 (none at this commit).
- Rate-limit enforcement (`rate_limit_buckets`) as a separate authority path.
- Durable workflow checkpoints as a privileged write path (`workflow_checkpoints`, class C).
