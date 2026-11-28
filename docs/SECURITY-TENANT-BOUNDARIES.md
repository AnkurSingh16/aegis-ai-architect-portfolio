# Tenant boundaries: what the database enforces and what relies on trusted code

Status: accurate as of the security-hardening branch (migrations 020 onward). It replaces the wording "tenant isolation at the database"
used in earlier P8 notes, which overstated the guarantee.

## 1. Mechanisms
- The tenant of a database session is the setting `aegis.tenant_id`. Any login can set it with `set_config`, so the database cannot tell
  an authorised tenant value from a forged one. Every row policy that uses it trusts the value the session presents.
- The runtime login (`aegis_app`) is additionally bound by the `aegis.access_mode` setting. Since migration 020 the fixture alternative is
  gone from its policies. Only `authenticated` mode with a membership reaches tenant rows.
- Workload logins (`aegis_orchestrator`, `aegis_triage`, `aegis_retrieval`, `aegis_reviewer`, `aegis_gateway`, `aegis_operator`) have
  their own roles. The agent identity is the login role, read through `aegis.current_agent()` (an invoker function). A session cannot
  change it with `SET ROLE` because no membership exists.

## 2. Database-enforced (tested)
| Guarantee | Where | Test |
|---|---|---|
| `aegis_app` reveals no case of another tenant when fixture mode is requested | 020 policies | `fixture-boundary.integration.test.ts` |
| `aegis_app` cannot insert a case for a tenant it does not belong to through fixture mode | 020 policies | same file |
| Changed session flags (authenticated mode, another tenant) reveal no case | 002 membership policy, 020 | same file |
| Without session flags `aegis_app` sees no case (no default allow) | 020 policies | same file |
| `aegis_app` cannot `SET ROLE aegis_fixture` | role membership | same file |
| The fixture role holds no audit write privilege and no sequence privilege | 020 grants | same file (fixture audit write refused, storage test) |
| The orchestrator records message events only as itself (actor = orchestrator) | 022 policy | `hardening-messaging-provenance` (test to be added; see open items) |
| `aegis_fixture` is not a login and has no membership | role definition, 020 | same file |
| A participant cannot read, lock or write execution, delegation, grant, execution-event, inbox or reply-insert rows of a tenant other than its session tenant | 021 policies | `hardening-tenant-bound-participants.integration.test.ts` (execution, delegation, grant and event paths only; lock, consume, inbox and reply paths are not yet tested) |
| A participant cannot change its workload identity with `SET ROLE` | role membership | same file |
| A participant cannot update execution status, revoke grants, or discover pending cancellations (no table privilege; no function grant) | 018 grants, 024 | `cancellation-reconciliation.integration.test.ts` (F) |
| Cancellation is finalised only by the orchestrator: bounded, idempotent, lease-preempting, and terminal results win | 024, orchestrator reconciliation | `cancellation-reconciliation.integration.test.ts` (A–E, H, K, L) |
| A cancellation request is refused for participants (triage, retrieval, reviewer) and no request grant is consumed after cancellation commits | 023 trigger (owner-run, backstop), receive refusal | `cancellation-reconciliation.integration.test.ts` (D, G, I, J) |
| Stage transitions and grant status moves are checked by triggers | 018, 023 | cancellation and provenance files |

## 3. Trusted application code (not enforced by the database)
- Which tenant a session is scoped to. The runtime sets `aegis.tenant_id` from a verified message or request. A compromised process that
  holds a participant login can set a different tenant and read the rows of that tenant where it participates in an execution. Migration 021
  narrows that exposure to participation in the chosen tenant. It does not stop a process from choosing another tenant. Closing this needs
  the tenant to come from a verified, database-checked grant (not yet implemented; see section 5).
- Principal identity for the public API: the token is verified in process; the principal is written to the database by the gateway.
- Membership checks run before the tenant setting is applied (`apps/api/src/auth/transaction.ts`). Their order is trusted; the database
  does not re-check it.

## 4. Deliberate cross-tenant mechanisms (narrow, documented)
- Outbox dispatch (`agent_outbox_sender_read`, `agent_outbox_sender_update`) is cross-tenant by design: one dispatcher per agent delivers
  its sender rows for every tenant. These policies are not tenant-bound by migration 021. Binding them needs a per-tenant dispatch loop or a
  claim function scoped to one tenant. This is a recorded residual.
- Orchestrator intake (`aegis.orchestrator_intake`, migration 019) is `SECURITY DEFINER` and returns submitted executions for every tenant. It
  checks the caller's identity with `session_user` and is executable only by `aegis_orchestrator`. It is the only cross-tenant read on the
  intake path. It is not a general bypass.
- Orchestrator cancellation discovery (`aegis.orchestrator_due_cancellations`, migrations 024, 025 and 026) returns the (tenant, execution,
  attempts, scheduling generation) identifiers of cancellations that are due for reconciliation, across tenants. It is executable only by
  `aegis_orchestrator`, takes no tenant or principal argument, caps results at 50, skips rows locked by another transaction (`SKIP
  LOCKED`), and returns nothing to any other role. Finalisation then runs in the tenant's own transaction under the row lock.
- Orchestrator cancellation backlog (`aegis.orchestrator_cancellation_backlog`, migration 025) returns aggregate counts and the oldest
  request age across tenants, with no identifiers. Executable only by `aegis_orchestrator`.
- The ingestion role and the synthetic catalog trigger (migration 004) accept owner, superuser and BYPASSRLS sessions. These are
  administrator sessions and are not reachable from application logins.

## 5. Residual risks and follow-up (not closed by this branch)
1. Tenant selection by a participant process is application-trusted (section 3). Follow-up: derive the tenant from a database-checked grant
   inside the policy, so a participant login cannot choose another tenant's execution.
2. Outbox dispatch is cross-tenant (section 4). Follow-up: tenant-scoped dispatch.
3. The owner of the `SECURITY DEFINER` functions must have BYPASSRLS or superuser, because they read `agent_executions` across tenants. The
   consumption trigger (023, replaced in 024 and 025) and the discovery and backlog functions (024, 025) depend on it. Phase A adds a
   startup validation (`verifyCancellationAuthority`, orchestrator only) that fails closed when the owner cannot see rows, when a function
   is missing, when PUBLIC or an unexpected role holds EXECUTE, when the search_path is not pinned, or when the runtime identity is a
   superuser or BYPASSRLS. Phase A.2 extends it: the owner must also hold the privileges the functions' statements need (SELECT on
   `agent_executions` and `agent_database_roles`, UPDATE on `agent_executions` for the `FOR UPDATE` discovery lock, schema usage on
   `aegis`), both triggers must be row-level BEFORE UPDATE, and the runtime identity must have schema usage and role-map access. BYPASSRLS
   alone is not treated as proof of access. Local stacks run the owner as a superuser, so the validation passes there. Narrowing the owner
   to a dedicated NOLOGIN role with only the required table privileges is not implemented; it needs a provisioning decision (F-02 in the
   review record). Open findings F2, F3, F4 and F7 are unchanged by this phase.
4. Participant read of the outbox and inbox across tenants is part of item 2.
5. No human security audit has been performed. This document is an engineering statement to be reviewed independently.

## 6. Open items and approvals (from the independent AI-assisted review of this branch)
These are not closed. Items marked APPROVAL need an explicit decision before the branch is merged or any of them is accepted as residual.
- F3 (APPROVAL, open): the principal (`aegis.principal_issuer`, `aegis.principal_subject`) and the access mode are plain session values.
  The membership policies trust them, so an application login that can run SQL can act as any member of any tenant. This is the same
  class of problem as the fixture bypass that remediation 1 removed, and it is not closed by this branch.
- F4 (APPROVAL, accepted residual proposed): outbox sender policies expose a participant's own sender rows across tenants, and let a
  participant update their delivery status. Closing it needs tenant-scoped dispatch or a narrow claim function.
- F7 (APPROVAL, accepted residual proposed): the ingestion login sets its own access mode and tenant; the document policies trust them.
- F2 (open functional gap): the development CLI (`apps/api/src/storage/cli.ts`) is not wired to `aegis_fixture`. Under `aegis_app` it sees
  no fixture rows and cannot write. Wiring needs an administrator-provisioned login and an explicit role switch.
- F1, F5, F6, F8 (fixed in this branch): audit write privilege removed from the fixture role; orchestrator message events bound to the
  orchestrator's own actor; fixture privileges reduced to the minimum; the fixture pool applies its role at connection start.
- Test coverage gaps: the lock, consume, inbox and reply paths of remediation 2 have no negative tests yet; the orchestrator actor
  binding (F5) has no negative test yet.
- The owner-role assumption (section 5 item 3) remains.
