-- P8 security hardening, remediation 3: messaging provenance and audit integrity. Additive. Migrations 001-021 are not changed.
--
-- Before this migration:
-- (a) The orchestrator's outbox insert policy (017, moved to aegis_orchestrator in 018) checked the lifecycle fields only, not the sender.
--     The orchestrator could enqueue a row whose sender_agent was triage, retrieval or reviewer; that agent's dispatcher would then
--     deliver it under that agent's mTLS identity.
-- (b) agent_message_events (017) referenced the tenant but not the execution. Its agent insert policy (018) did not bind the tenant.
--     A participant could insert an audit event labelled with another tenant's identifier and an execution of that tenant.
--
-- After this migration:
-- (a) The orchestrator may insert outbox rows only as its own sender (sender_agent = aegis.current_agent() = 'orchestrator').
--     Participant replies are already bound to their own sender by agent_outbox_agent_reply (018); they are unchanged.
-- (b) The message-event insert must carry the session tenant, and (tenant_id, execution_id) must reference an existing execution of
--     that tenant. The composite key UNIQUE (tenant_id, execution_id) exists on aegis.agent_executions (016), so the foreign key is
--     applicable. Existing rows are consistent because every message-event row was written with a tenant-scoped execution reference.
--
-- Unchanged: transactional outbox and inbox semantics, fencing, the append-only triggers on message events and outbox actions, and
-- the delivery and acknowledgement rules.

ALTER POLICY agent_outbox_tenant_insert ON aegis.agent_outbox
  WITH CHECK (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid
    AND sender_agent = aegis.current_agent()
    AND status = 'pending' AND attempts = 0 AND fencing_token = 0 AND lease_instance IS NULL AND delivered_at IS NULL AND dead_at IS NULL);

-- The orchestrator also held a tenant-only insert policy (017, moved to aegis_orchestrator in 018). PostgreSQL combines permissive
-- policies with OR, so that policy alone would have allowed any actor label. The orchestrator may record events only as itself.
ALTER POLICY agent_message_event_tenant_insert ON aegis.agent_message_events
  WITH CHECK (agent_message_events.tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid
    AND actor_agent = aegis.current_agent());

ALTER POLICY agent_message_event_agent_insert ON aegis.agent_message_events
  WITH CHECK (agent_message_events.tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid
    AND actor_agent = aegis.current_agent() AND EXISTS (SELECT 1 FROM aegis.agent_delegations d
      WHERE d.execution_id = agent_message_events.execution_id AND aegis.current_agent() IN (d.from_agent, d.to_agent)));

ALTER TABLE aegis.agent_message_events
  ADD CONSTRAINT agent_message_events_execution_fk
  FOREIGN KEY (tenant_id, execution_id) REFERENCES aegis.agent_executions (tenant_id, execution_id);
