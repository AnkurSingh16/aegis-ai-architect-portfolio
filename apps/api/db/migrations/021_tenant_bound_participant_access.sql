-- P8 security hardening, remediation 2: bind participant-agent access to the tenant as well as to participation.
-- Additive. Migrations 001-020 are not changed. Only policies are altered; no table, grant or data is changed.
--
-- Before this migration, a participant (aegis_triage, aegis_retrieval, aegis_reviewer) could read and, for grants addressed to it,
-- change execution, delegation, grant, inbox and reply rows for any tenant, as long as it was named in a delegation of that execution.
-- Participation was the only predicate. Tenant identity came only from the session setting, which the runtime sets per message.
--
-- After this migration, each of these policies also requires the row's tenant to equal the tenant the session is scoped to
-- (aegis.tenant_id). A runtime that has not scoped a tenant (an empty setting) sees and changes none of these rows.
--
-- DELIBERATELY NOT CHANGED: the outbox sender policies (agent_outbox_sender_read, agent_outbox_sender_update). The dispatcher is a
-- single process per agent that delivers its sender rows for every tenant (aegis.dispatch is cross-tenant by design). Binding those
-- policies to one tenant needs a per-tenant dispatch loop or a narrowly scoped claim function. That is recorded as a residual risk in
-- docs/SECURITY-TENANT-BOUNDARIES.md and is not closed by this migration.
--
-- Database-enforced guarantee after this migration: a participant session scoped to tenant A cannot read, lock or write execution,
-- delegation, grant, execution-event, inbox or reply-insert rows of tenant B, even if it is a delegation participant of a tenant-B execution.
-- Outbox rows are excluded: the sender policies (018) still expose a participant's own sender rows across tenants (recorded residual).

ALTER POLICY agent_execution_participant_read ON aegis.agent_executions
  USING (agent_executions.tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM aegis.agent_delegations d WHERE d.execution_id = agent_executions.execution_id
      AND aegis.current_agent() IN (d.from_agent, d.to_agent)));

ALTER POLICY agent_execution_participant_lock ON aegis.agent_executions
  USING (agent_executions.tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM aegis.agent_delegations d WHERE d.execution_id = agent_executions.execution_id
      AND aegis.current_agent() IN (d.from_agent, d.to_agent)))
  WITH CHECK (agent_executions.tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM aegis.agent_delegations d WHERE d.execution_id = agent_executions.execution_id
      AND aegis.current_agent() IN (d.from_agent, d.to_agent)));

ALTER POLICY agent_delegation_participant_read ON aegis.agent_delegations
  USING (agent_delegations.tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid
    AND aegis.current_agent() IN (from_agent, to_agent));

ALTER POLICY agent_grant_participant_read ON aegis.agent_grants
  USING (agent_grants.tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid
    AND aegis.current_agent() IN (from_agent, to_agent));

ALTER POLICY agent_grant_recipient_consume ON aegis.agent_grants
  USING (agent_grants.tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid
    AND to_agent = aegis.current_agent() AND status = 'open' AND expires_at > clock_timestamp())
  WITH CHECK (agent_grants.tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid
    AND to_agent = aegis.current_agent() AND status = 'consumed' AND consumed_by_agent = aegis.current_agent());

ALTER POLICY agent_grant_participant_expire ON aegis.agent_grants
  USING (agent_grants.tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid
    AND aegis.current_agent() IN (from_agent, to_agent) AND status = 'open' AND expires_at <= clock_timestamp())
  WITH CHECK (status = 'revoked');

ALTER POLICY agent_event_agent_insert ON aegis.agent_execution_events
  WITH CHECK (agent_execution_events.tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid
    AND actor_agent = aegis.current_agent() AND EXISTS (SELECT 1 FROM aegis.agent_delegations d
      WHERE d.execution_id = agent_execution_events.execution_id AND aegis.current_agent() IN (d.from_agent, d.to_agent)));

ALTER POLICY agent_outbox_agent_reply ON aegis.agent_outbox
  WITH CHECK (agent_outbox.tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid
    AND sender_agent = aegis.current_agent() AND kind = 'result' AND destination_agent = 'orchestrator'
    AND status = 'pending' AND attempts = 0 AND fencing_token = 0 AND lease_instance IS NULL AND delivered_at IS NULL AND dead_at IS NULL
    AND EXISTS (SELECT 1 FROM aegis.agent_grants g WHERE g.execution_id = agent_outbox.execution_id
      AND g.tenant_id = agent_outbox.tenant_id AND g.to_agent = aegis.current_agent() AND g.kind = 'request' AND g.status = 'consumed'));

ALTER POLICY agent_inbox_receiver_read ON aegis.agent_inbox
  USING (agent_inbox.tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid
    AND receiver_agent = aegis.current_agent());

ALTER POLICY agent_inbox_receiver_insert ON aegis.agent_inbox
  WITH CHECK (agent_inbox.tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid
    AND receiver_agent = aegis.current_agent() AND outcome = 'received' AND decided_at IS NULL
    AND EXISTS (SELECT 1 FROM aegis.agent_delegations d WHERE d.execution_id = agent_inbox.execution_id
      AND aegis.current_agent() IN (d.from_agent, d.to_agent)));

ALTER POLICY agent_inbox_receiver_update ON aegis.agent_inbox
  USING (agent_inbox.tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid AND receiver_agent = aegis.current_agent())
  WITH CHECK (agent_inbox.tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid AND receiver_agent = aegis.current_agent());
