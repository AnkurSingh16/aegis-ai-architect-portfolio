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
| `aegis_fixture` is not a login and has no membership | role definition, 020 | same file |
| A participant cannot read, lock or write rows of an execution, delegation, grant, reply or inbox row of a tenant other than its session tenant | 021 policies | `hardening-tenant-bound-participants.integration.test.ts` |
| A participant cannot change its workload identity with `SET ROLE` | role membership | same file |
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
- The ingestion role and the synthetic catalog trigger (migration 004) accept owner, superuser and BYPASSRLS sessions. These are
  administrator sessions and are not reachable from application logins.

## 5. Residual risks and follow-up (not closed by this branch)
1. Tenant selection by a participant process is application-trusted (section 3). Follow-up: derive the tenant from a database-checked grant
   inside the policy, so a participant login cannot choose another tenant's execution.
2. Outbox dispatch is cross-tenant (section 4). Follow-up: tenant-scoped dispatch.
3. The owner of the `SECURITY DEFINER` functions must have BYPASSRLS or explicit policies. Local stacks run as a superuser. Follow-up: startup
   assertion (F-02 in the review record).
4. Participant read of the outbox and inbox across tenants is part of item 2.
5. No human security audit has been performed. This document is an engineering statement to be reviewed independently.
