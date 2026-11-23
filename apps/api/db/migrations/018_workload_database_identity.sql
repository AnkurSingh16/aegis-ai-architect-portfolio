-- P8: database workload identity. Additive: migrations 001-017 are not changed.
--
-- Before this migration, every messaging operation ran as the shared runtime role aegis_app and scoped itself with the session setting
-- aegis.agent_id. Any process holding aegis_app could set that setting to another agent and act as it. That is removed here.
--
-- After this migration:
-- - each workload connects with its own database role (aegis_orchestrator, aegis_triage, aegis_retrieval, aegis_reviewer). The
--   gateway (the authenticated API) and the operator process have their own roles too;
-- - the agent identity of a database session is derived on the server from the login role, through aegis.agent_database_roles, which
--   no session can change. aegis.current_agent() replaces aegis.agent_id everywhere in the messaging policies;
-- - an agent role can act only for its own sender and recipient rows, and only on executions in which it is a delegation participant;
-- - only the orchestrator role may create delegations, issue grants, claim leases and write execution-level state;
-- - agent roles cannot modify registrations, executions (beyond a version counter that row locks need), budgets or stages;
-- - operator actions (requeue, purge) have their own role and their own audited table.
-- Tenant scope for the orchestrator and the gateway still comes from the transaction's tenant setting, which is set from verified
-- inputs by application code; see docs/P8-INVESTIGATION-WORKFLOW.md for the residual risk.

-- ---------------------------------------------------------------------------------------------------------------------------------
-- Roles. NOLOGIN here. Login credentials are provisioned by the administrator tool (storage/agent-roles-cli.ts), never by migrations.
-- ---------------------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['aegis_orchestrator', 'aegis_triage', 'aegis_retrieval', 'aegis_reviewer', 'aegis_gateway', 'aegis_operator']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT NOCREATEROLE NOCREATEDB NOBYPASSRLS', r);
    END IF;
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA aegis TO aegis_orchestrator, aegis_triage, aegis_retrieval, aegis_reviewer, aegis_gateway, aegis_operator;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- Server-controlled mapping from database login role to agent identity. Read-only for every role; written only by migrations.
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE aegis.agent_database_roles (
  role_name name PRIMARY KEY CHECK (role_name IN ('aegis_orchestrator', 'aegis_triage', 'aegis_retrieval', 'aegis_reviewer',
    'aegis_gateway', 'aegis_operator')),
  agent_id text REFERENCES aegis.agent_registrations (agent_id),
  CHECK ((role_name IN ('aegis_gateway', 'aegis_operator')) = (agent_id IS NULL)),
  CHECK (agent_id IS NULL OR role_name = 'aegis_' || agent_id)
);
INSERT INTO aegis.agent_database_roles (role_name, agent_id) VALUES
  ('aegis_orchestrator', 'orchestrator'), ('aegis_triage', 'triage'), ('aegis_retrieval', 'retrieval'), ('aegis_reviewer', 'reviewer'),
  ('aegis_gateway', NULL), ('aegis_operator', NULL);
ALTER TABLE aegis.agent_database_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE aegis.agent_database_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_database_role_read ON aegis.agent_database_roles FOR SELECT
  TO aegis_orchestrator, aegis_triage, aegis_retrieval, aegis_reviewer, aegis_gateway, aegis_operator USING (true);
REVOKE ALL ON TABLE aegis.agent_database_roles FROM PUBLIC;
GRANT SELECT ON TABLE aegis.agent_database_roles TO aegis_orchestrator, aegis_triage, aegis_retrieval, aegis_reviewer, aegis_gateway, aegis_operator;

-- The identity of this session. Derived from the login role (current_user). A session cannot change it: the roles are not members of
-- one another, so SET ROLE to another workload is not permitted, and aegis.agent_id is no longer read by any policy.
CREATE FUNCTION aegis.current_agent() RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, aegis AS $$
  SELECT m.agent_id FROM aegis.agent_database_roles m WHERE m.role_name = current_user AND m.agent_id IS NOT NULL
$$;
REVOKE ALL ON FUNCTION aegis.current_agent() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aegis.current_agent() TO aegis_orchestrator, aegis_triage, aegis_retrieval, aegis_reviewer;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- Orchestration stage. The explicit state machine of one investigation. Transitions are checked by a trigger, not by the application.
-- ---------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE aegis.agent_executions ADD COLUMN workflow_stage text NOT NULL DEFAULT 'submitted'
  CHECK (workflow_stage IN ('submitted', 'triage_requested', 'plan_received', 'retrieval_requested', 'evidence_received',
    'review_requested', 'review_received', 'completed', 'insufficient_evidence', 'failed', 'cancelled'));
-- The relation between stage and status is enforced by the application's single transition function (see docs), not by a constraint,
-- because rows created before this migration have status but no stage.

CREATE FUNCTION aegis.stage_transition_allowed(from_stage text, to_stage text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT (from_stage, to_stage) IN (
    ('submitted', 'triage_requested'), ('submitted', 'cancelled'), ('submitted', 'failed'),
    ('triage_requested', 'plan_received'), ('triage_requested', 'failed'), ('triage_requested', 'cancelled'),
    ('plan_received', 'retrieval_requested'), ('plan_received', 'insufficient_evidence'), ('plan_received', 'failed'),
    ('plan_received', 'cancelled'),
    ('retrieval_requested', 'evidence_received'), ('retrieval_requested', 'insufficient_evidence'),
    ('retrieval_requested', 'failed'), ('retrieval_requested', 'cancelled'),
    ('evidence_received', 'review_requested'), ('evidence_received', 'insufficient_evidence'), ('evidence_received', 'failed'),
    ('evidence_received', 'cancelled'),
    ('review_requested', 'review_received'), ('review_requested', 'failed'), ('review_requested', 'cancelled'),
    ('review_received', 'completed'), ('review_received', 'insufficient_evidence'), ('review_received', 'retrieval_requested'),
    ('review_received', 'failed'), ('review_received', 'cancelled'))
$$;

CREATE FUNCTION aegis.enforce_stage_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, aegis AS $$
BEGIN
  IF NEW.workflow_stage IS DISTINCT FROM OLD.workflow_stage
     AND NOT aegis.stage_transition_allowed(OLD.workflow_stage, NEW.workflow_stage) THEN
    RAISE EXCEPTION 'workflow stage transition is not permitted' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION aegis.enforce_stage_transition() FROM PUBLIC;
CREATE TRIGGER agent_execution_stage_transition BEFORE UPDATE OF workflow_stage ON aegis.agent_executions
  FOR EACH ROW EXECUTE FUNCTION aegis.enforce_stage_transition();

-- Budgets are counted where the grant is consumed, under the same lock, by the database. A recipient needs no right to write the
-- counter. Owner-executed (SECURITY DEFINER) so that the counter cannot be written by any other path.
CREATE FUNCTION aegis.count_consumed_envelope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, aegis AS $$
BEGIN
  UPDATE aegis.agent_executions SET steps_taken = steps_taken + 1, updated_at = clock_timestamp()
   WHERE execution_id = NEW.execution_id AND tenant_id = NEW.tenant_id;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION aegis.count_consumed_envelope() FROM PUBLIC;
CREATE TRIGGER agent_grant_counts_step AFTER UPDATE OF status ON aegis.agent_grants
  FOR EACH ROW WHEN (NEW.status = 'consumed' AND OLD.status = 'open') EXECUTE FUNCTION aegis.count_consumed_envelope();

-- A grant may be consumed only before it expires. Enforced in the policy below and checked again here.
CREATE FUNCTION aegis.forbid_expired_consumption() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.status = 'consumed' AND OLD.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'grant has expired' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION aegis.forbid_expired_consumption() FROM PUBLIC;
CREATE TRIGGER agent_grant_not_expired BEFORE UPDATE OF status ON aegis.agent_grants
  FOR EACH ROW EXECUTE FUNCTION aegis.forbid_expired_consumption();

-- The orchestrator's intake: executions submitted through the gateway that no orchestrator has started yet. Runs as a function so that
-- only the orchestrator role can see executions across tenants, and only their stage and tenant identifiers.
CREATE FUNCTION aegis.orchestrator_intake(p_limit integer)
RETURNS TABLE (tenant_id uuid, execution_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, aegis AS $$
  SELECT e.tenant_id, e.execution_id FROM aegis.agent_executions e
   WHERE e.workflow_stage = 'submitted' AND e.status = 'pending'
     AND aegis.current_agent() = 'orchestrator'
   ORDER BY e.created_at, e.execution_id LIMIT GREATEST(1, LEAST(p_limit, 50))
$$;
REVOKE ALL ON FUNCTION aegis.orchestrator_intake(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aegis.orchestrator_intake(integer) TO aegis_orchestrator;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- Investigation request and result records (tenant-owned). The request text is bounded user data. The result is written only by the
-- orchestrator after the final reviewer decision.
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE aegis.investigation_requests (
  execution_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES aegis.tenants (id),
  question text NOT NULL CHECK (char_length(question) BETWEEN 1 AND 1000),
  question_digest text NOT NULL CHECK (question_digest ~ '^[0-9a-f]{64}$'),
  principal_ref text NOT NULL CHECK (principal_ref ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, execution_id) REFERENCES aegis.agent_executions (tenant_id, execution_id)
);

CREATE TABLE aegis.investigation_results (
  execution_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES aegis.tenants (id),
  verdict text NOT NULL CHECK (verdict IN ('answered', 'insufficient_evidence', 'failed')),
  answer text CHECK (answer IS NULL OR char_length(answer) BETWEEN 1 AND 2000),
  citations jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(citations) = 'array' AND octet_length(citations::text) <= 8192),
  reviewer_decision text NOT NULL CHECK (reviewer_decision IN ('approve', 'insufficient_evidence', 'reject', 'not_reviewed')),
  failure_reason text CHECK (failure_reason IS NULL OR failure_reason ~ '^[a-z_]{1,40}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, execution_id) REFERENCES aegis.agent_executions (tenant_id, execution_id),
  CHECK ((verdict = 'answered') = (answer IS NOT NULL AND reviewer_decision = 'approve')),
  CHECK ((verdict = 'failed') = (failure_reason IS NOT NULL))
);

-- The candidate answer the orchestrator asked the reviewer to check, with its citations. Written before the review is requested, so the
-- final result is built from what was actually reviewed, not from a value echoed back by the reviewer.
CREATE TABLE aegis.investigation_candidates (
  execution_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES aegis.tenants (id),
  answer text NOT NULL CHECK (char_length(answer) BETWEEN 1 AND 800),
  claims jsonb NOT NULL CHECK (jsonb_typeof(claims) = 'array' AND octet_length(claims::text) <= 4096),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, execution_id) REFERENCES aegis.agent_executions (tenant_id, execution_id)
);

ALTER TABLE aegis.investigation_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE aegis.investigation_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE aegis.investigation_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE aegis.investigation_results FORCE ROW LEVEL SECURITY;
ALTER TABLE aegis.investigation_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE aegis.investigation_candidates FORCE ROW LEVEL SECURITY;
CREATE POLICY investigation_candidate_tenant_read ON aegis.investigation_candidates FOR SELECT TO aegis_orchestrator
  USING (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid);
CREATE POLICY investigation_candidate_tenant_insert ON aegis.investigation_candidates FOR INSERT TO aegis_orchestrator
  WITH CHECK (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON aegis.investigation_candidates TO aegis_orchestrator;


CREATE POLICY investigation_request_tenant_read ON aegis.investigation_requests FOR SELECT TO aegis_gateway, aegis_orchestrator
  USING (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid);
CREATE POLICY investigation_request_gateway_insert ON aegis.investigation_requests FOR INSERT TO aegis_gateway
  WITH CHECK (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid);
CREATE POLICY investigation_result_tenant_read ON aegis.investigation_results FOR SELECT TO aegis_gateway, aegis_orchestrator
  USING (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid);
CREATE POLICY investigation_result_orchestrator_insert ON aegis.investigation_results FOR INSERT TO aegis_orchestrator
  WITH CHECK (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid);

CREATE FUNCTION aegis.forbid_investigation_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'investigation records are append-only' USING ERRCODE = '42501';
END;
$$;
REVOKE ALL ON FUNCTION aegis.forbid_investigation_change() FROM PUBLIC;
CREATE TRIGGER investigation_request_append_only BEFORE UPDATE OR DELETE ON aegis.investigation_requests
  FOR EACH ROW EXECUTE FUNCTION aegis.forbid_investigation_change();
CREATE TRIGGER investigation_result_append_only BEFORE UPDATE OR DELETE ON aegis.investigation_results
  FOR EACH ROW EXECUTE FUNCTION aegis.forbid_investigation_change();
CREATE TRIGGER investigation_candidate_append_only BEFORE UPDATE OR DELETE ON aegis.investigation_candidates
  FOR EACH ROW EXECUTE FUNCTION aegis.forbid_investigation_change();

-- ---------------------------------------------------------------------------------------------------------------------------------
-- Drop the policies that trusted the session setting aegis.agent_id, and the operator policies on the runtime role.
-- ---------------------------------------------------------------------------------------------------------------------------------
DROP POLICY agent_outbox_dispatch_select ON aegis.agent_outbox;
DROP POLICY agent_outbox_dispatch_update ON aegis.agent_outbox;
DROP POLICY agent_inbox_tenant_insert ON aegis.agent_inbox;
DROP POLICY agent_inbox_tenant_update ON aegis.agent_inbox;
DROP POLICY agent_outbox_tenant_requeue ON aegis.agent_outbox;
DROP POLICY agent_outbox_tenant_purge ON aegis.agent_outbox;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- Existing policies move from the shared role to the orchestrator (tenant scope) and the gateway where they are needed.
-- ---------------------------------------------------------------------------------------------------------------------------------
ALTER POLICY agent_registration_read ON aegis.agent_registrations TO aegis_orchestrator, aegis_triage, aegis_retrieval,
  aegis_reviewer, aegis_gateway, aegis_operator;
ALTER POLICY agent_execution_tenant_read ON aegis.agent_executions TO aegis_orchestrator, aegis_gateway;
ALTER POLICY agent_execution_tenant_insert ON aegis.agent_executions TO aegis_orchestrator, aegis_gateway;
ALTER POLICY agent_execution_tenant_update ON aegis.agent_executions TO aegis_orchestrator;
ALTER POLICY agent_delegation_tenant_read ON aegis.agent_delegations TO aegis_orchestrator;
ALTER POLICY agent_delegation_tenant_insert ON aegis.agent_delegations TO aegis_orchestrator;
ALTER POLICY agent_grant_tenant_read ON aegis.agent_grants TO aegis_orchestrator;
ALTER POLICY agent_grant_tenant_insert ON aegis.agent_grants TO aegis_orchestrator;
ALTER POLICY agent_grant_tenant_update ON aegis.agent_grants TO aegis_orchestrator;
ALTER POLICY agent_event_tenant_read ON aegis.agent_execution_events TO aegis_orchestrator;
ALTER POLICY agent_event_tenant_insert ON aegis.agent_execution_events TO aegis_orchestrator, aegis_gateway;
ALTER POLICY agent_outbox_tenant_read ON aegis.agent_outbox TO aegis_orchestrator;
ALTER POLICY agent_outbox_tenant_insert ON aegis.agent_outbox TO aegis_orchestrator;
ALTER POLICY agent_inbox_tenant_read ON aegis.agent_inbox TO aegis_orchestrator;
ALTER POLICY agent_message_event_tenant_read ON aegis.agent_message_events TO aegis_orchestrator;
ALTER POLICY agent_message_event_tenant_insert ON aegis.agent_message_events TO aegis_orchestrator;
ALTER POLICY agent_outbox_action_tenant_read ON aegis.agent_outbox_actions TO aegis_operator;
ALTER POLICY agent_outbox_action_tenant_insert ON aegis.agent_outbox_actions TO aegis_operator;

-- Gateway reads the verified principal's executions (the query filters by principal_ref; the gateway is the trusted verifier).
CREATE POLICY agent_execution_gateway_cancel ON aegis.agent_executions FOR UPDATE TO aegis_gateway
  USING (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '') ::uuid AND cancel_requested);
CREATE POLICY membership_gateway_read ON aegis.memberships FOR SELECT TO aegis_gateway USING (true);
GRANT SELECT ON aegis.memberships TO aegis_gateway;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- Agent policies (triage, retrieval, reviewer, and the orchestrator for its own inbox and outbox). Identity: aegis.current_agent().
-- ---------------------------------------------------------------------------------------------------------------------------------
-- A participant is an agent named as sender or recipient of a delegation in the execution.
CREATE POLICY agent_execution_participant_read ON aegis.agent_executions FOR SELECT TO aegis_triage, aegis_retrieval, aegis_reviewer
  USING (EXISTS (SELECT 1 FROM aegis.agent_delegations d WHERE d.execution_id = agent_executions.execution_id
    AND aegis.current_agent() IN (d.from_agent, d.to_agent)));
CREATE POLICY agent_execution_participant_lock ON aegis.agent_executions FOR UPDATE TO aegis_triage, aegis_retrieval, aegis_reviewer
  USING (EXISTS (SELECT 1 FROM aegis.agent_delegations d WHERE d.execution_id = agent_executions.execution_id
    AND aegis.current_agent() IN (d.from_agent, d.to_agent)))
  WITH CHECK (EXISTS (SELECT 1 FROM aegis.agent_delegations d WHERE d.execution_id = agent_executions.execution_id
    AND aegis.current_agent() IN (d.from_agent, d.to_agent)));
CREATE POLICY agent_delegation_participant_read ON aegis.agent_delegations FOR SELECT TO aegis_triage, aegis_retrieval, aegis_reviewer
  USING (aegis.current_agent() IN (from_agent, to_agent));
CREATE POLICY agent_grant_participant_read ON aegis.agent_grants FOR SELECT TO aegis_triage, aegis_retrieval, aegis_reviewer
  USING (aegis.current_agent() IN (from_agent, to_agent));
-- Consumption: only the addressed recipient, only while open and unexpired, and only as consumed by itself.
CREATE POLICY agent_grant_recipient_consume ON aegis.agent_grants FOR UPDATE TO aegis_triage, aegis_retrieval, aegis_reviewer
  USING (to_agent = aegis.current_agent() AND status = 'open' AND expires_at > clock_timestamp())
  WITH CHECK (to_agent = aegis.current_agent() AND status = 'consumed' AND consumed_by_agent = aegis.current_agent());
-- Expired open grants may be revoked by a participant (the sweep that precedes every decision).
CREATE POLICY agent_grant_participant_expire ON aegis.agent_grants FOR UPDATE TO aegis_triage, aegis_retrieval, aegis_reviewer
  USING (aegis.current_agent() IN (from_agent, to_agent) AND status = 'open' AND expires_at <= clock_timestamp())
  WITH CHECK (status = 'revoked');
CREATE POLICY agent_message_event_agent_insert ON aegis.agent_message_events FOR INSERT TO aegis_triage, aegis_retrieval, aegis_reviewer, aegis_orchestrator
  WITH CHECK (actor_agent = aegis.current_agent() AND EXISTS (SELECT 1 FROM aegis.agent_delegations d
    WHERE d.execution_id = agent_message_events.execution_id AND aegis.current_agent() IN (d.from_agent, d.to_agent)));
CREATE POLICY agent_event_agent_insert ON aegis.agent_execution_events FOR INSERT TO aegis_triage, aegis_retrieval, aegis_reviewer
  WITH CHECK (actor_agent = aegis.current_agent() AND EXISTS (SELECT 1 FROM aegis.agent_delegations d
    WHERE d.execution_id = agent_execution_events.execution_id AND aegis.current_agent() IN (d.from_agent, d.to_agent)));

-- Outbox: an agent dispatches only its own sender rows. A reply is possible only after the agent consumed an inbound request grant
-- in the same execution, and only to the root agent. A result is therefore never produced without a verified request.
CREATE POLICY agent_outbox_sender_read ON aegis.agent_outbox FOR SELECT TO aegis_orchestrator, aegis_triage, aegis_retrieval, aegis_reviewer
  USING (sender_agent = aegis.current_agent());
-- Lifecycle updates of undelivered rows only. A dead message is not the sender's to change: only the operator role may requeue it.
CREATE POLICY agent_outbox_sender_update ON aegis.agent_outbox FOR UPDATE TO aegis_orchestrator, aegis_triage, aegis_retrieval, aegis_reviewer
  USING (sender_agent = aegis.current_agent() AND status IN ('pending', 'leased'))
  WITH CHECK (sender_agent = aegis.current_agent() AND status IN ('pending', 'leased', 'delivered', 'dead'));
CREATE POLICY agent_outbox_agent_reply ON aegis.agent_outbox FOR INSERT TO aegis_triage, aegis_retrieval, aegis_reviewer
  WITH CHECK (sender_agent = aegis.current_agent() AND kind = 'result' AND destination_agent = 'orchestrator'
    AND status = 'pending' AND attempts = 0 AND fencing_token = 0 AND lease_instance IS NULL AND delivered_at IS NULL AND dead_at IS NULL
    AND EXISTS (SELECT 1 FROM aegis.agent_grants g WHERE g.execution_id = agent_outbox.execution_id
      AND g.to_agent = aegis.current_agent() AND g.kind = 'request' AND g.status = 'consumed'));

-- Inbox: an agent sees and writes only its own receipts, for executions in which it participates.
CREATE POLICY agent_inbox_receiver_read ON aegis.agent_inbox FOR SELECT TO aegis_orchestrator, aegis_triage, aegis_retrieval, aegis_reviewer
  USING (receiver_agent = aegis.current_agent());
CREATE POLICY agent_inbox_receiver_insert ON aegis.agent_inbox FOR INSERT TO aegis_orchestrator, aegis_triage, aegis_retrieval, aegis_reviewer
  WITH CHECK (receiver_agent = aegis.current_agent() AND outcome = 'received' AND decided_at IS NULL
    AND EXISTS (SELECT 1 FROM aegis.agent_delegations d WHERE d.execution_id = agent_inbox.execution_id
      AND aegis.current_agent() IN (d.from_agent, d.to_agent)));
CREATE POLICY agent_inbox_receiver_update ON aegis.agent_inbox FOR UPDATE TO aegis_orchestrator, aegis_triage, aegis_retrieval, aegis_reviewer
  USING (receiver_agent = aegis.current_agent()) WITH CHECK (receiver_agent = aegis.current_agent());

-- Retrieval reads the tenant's documents only when it participates in an execution of that tenant, and only inside the tenant scope
-- that the retrieval runtime sets from its verified, consumed request grant.
CREATE POLICY document_retrieval_participant ON aegis.documents FOR SELECT TO aegis_retrieval
  USING (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid AND EXISTS (SELECT 1 FROM aegis.agent_delegations d
    JOIN aegis.agent_executions e ON e.execution_id = d.execution_id
    WHERE d.to_agent = aegis.current_agent() AND e.tenant_id = documents.tenant_id));
CREATE POLICY document_chunk_retrieval_participant ON aegis.document_chunks FOR SELECT TO aegis_retrieval
  USING (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid AND EXISTS (SELECT 1 FROM aegis.agent_delegations d
    JOIN aegis.agent_executions e ON e.execution_id = d.execution_id
    WHERE d.to_agent = aegis.current_agent() AND e.tenant_id = document_chunks.tenant_id));

-- Operator: requeue and purge are separate, audited actions under their own role. The runtime and the orchestrator have no such rights.
CREATE POLICY agent_outbox_operator_requeue ON aegis.agent_outbox FOR UPDATE TO aegis_operator
  USING (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid AND status = 'dead')
  WITH CHECK (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid);
CREATE POLICY agent_outbox_operator_read ON aegis.agent_outbox FOR SELECT TO aegis_operator
  USING (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid);
CREATE POLICY agent_outbox_operator_purge ON aegis.agent_outbox FOR DELETE TO aegis_operator
  USING (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid AND status = 'delivered');
CREATE POLICY agent_message_event_operator_insert ON aegis.agent_message_events FOR INSERT TO aegis_operator
  WITH CHECK (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid);

-- ---------------------------------------------------------------------------------------------------------------------------------
-- Privileges. First withdraw everything from the shared role on messaging tables; then grant each workload only what it needs.
-- ---------------------------------------------------------------------------------------------------------------------------------
REVOKE ALL ON TABLE aegis.investigation_candidates FROM aegis_app;
REVOKE ALL ON TABLE aegis.agent_registrations, aegis.agent_executions, aegis.agent_delegations, aegis.agent_grants,
  aegis.agent_execution_events, aegis.agent_outbox, aegis.agent_inbox, aegis.agent_message_events, aegis.agent_outbox_actions,
  aegis.investigation_requests, aegis.investigation_results FROM aegis_app;

-- Orchestrator: the full P4/P5 surface it had as aegis_app, plus its stage.
GRANT SELECT ON aegis.agent_registrations TO aegis_orchestrator;
GRANT SELECT, INSERT (tenant_id, idempotency_key, principal_ref, principal_scopes, root_agent, status, max_depth, max_delegations,
  max_steps, grant_ttl_seconds, max_attempts, version, fencing_token, attempts, steps_taken, delegations_issued, cancel_requested)
  ON aegis.agent_executions TO aegis_orchestrator, aegis_gateway;
GRANT SELECT ON aegis.agent_executions TO aegis_orchestrator, aegis_gateway;
GRANT UPDATE (status, delegations_issued, attempts, fencing_token, lease_agent_id, lease_instance, lease_expires_at,
  cancel_requested, cancel_reason, version, updated_at, workflow_stage) ON aegis.agent_executions TO aegis_orchestrator;
GRANT UPDATE (cancel_requested, cancel_reason, version, updated_at) ON aegis.agent_executions TO aegis_gateway;
GRANT SELECT, INSERT ON aegis.agent_delegations TO aegis_orchestrator;
GRANT SELECT, INSERT ON aegis.agent_grants TO aegis_orchestrator;
GRANT UPDATE (status, consumed_at, consumed_by_agent, consumed_by_fencing_token, revoked_at) ON aegis.agent_grants TO aegis_orchestrator;
GRANT SELECT, INSERT ON aegis.agent_execution_events TO aegis_orchestrator, aegis_gateway;
GRANT SELECT, INSERT ON aegis.agent_outbox TO aegis_orchestrator;
GRANT UPDATE (status, attempts, max_attempts, next_attempt_at, fencing_token, lease_instance, lease_expires_at, last_error, delivered_at,
  dead_at, dead_reason, updated_at) ON aegis.agent_outbox TO aegis_orchestrator, aegis_triage, aegis_retrieval, aegis_reviewer;
GRANT SELECT ON aegis.agent_outbox TO aegis_triage, aegis_retrieval, aegis_reviewer;
GRANT INSERT ON aegis.agent_outbox TO aegis_triage, aegis_retrieval, aegis_reviewer;
GRANT SELECT, INSERT ON aegis.agent_inbox TO aegis_orchestrator, aegis_triage, aegis_retrieval, aegis_reviewer;
GRANT UPDATE (outcome, refusal_reason, grant_id, result_message_id, result_digest, decided_at) ON aegis.agent_inbox
  TO aegis_orchestrator, aegis_triage, aegis_retrieval, aegis_reviewer;
GRANT SELECT, INSERT ON aegis.agent_message_events TO aegis_orchestrator, aegis_operator;
GRANT SELECT, INSERT ON aegis.agent_outbox_actions TO aegis_operator;
GRANT SELECT, UPDATE (status, attempts, max_attempts, next_attempt_at, dead_at, dead_reason, last_error, updated_at), DELETE
  ON aegis.agent_outbox TO aegis_operator;
GRANT USAGE ON SEQUENCE aegis.agent_execution_events_event_id_seq, aegis.agent_message_events_event_id_seq,
  aegis.agent_outbox_actions_action_id_seq TO aegis_orchestrator, aegis_triage, aegis_retrieval, aegis_reviewer, aegis_gateway,
  aegis_operator;

-- Triage, retrieval and reviewer: read their participation, lock executions (version only), consume their own grants, write their
-- events, and dispatch their replies. Nothing else.
GRANT SELECT ON aegis.agent_registrations, aegis.agent_executions, aegis.agent_delegations, aegis.agent_grants TO aegis_triage, aegis_retrieval, aegis_reviewer;
GRANT UPDATE (version) ON aegis.agent_executions TO aegis_triage, aegis_retrieval, aegis_reviewer;
GRANT UPDATE (status, consumed_at, consumed_by_agent, consumed_by_fencing_token, revoked_at) ON aegis.agent_grants TO aegis_triage, aegis_retrieval, aegis_reviewer;
GRANT INSERT ON aegis.agent_execution_events TO aegis_triage, aegis_retrieval, aegis_reviewer;
GRANT INSERT ON aegis.agent_message_events TO aegis_triage, aegis_retrieval, aegis_reviewer;
GRANT SELECT ON aegis.agent_execution_events TO aegis_orchestrator;

-- The orchestrator also consumes its own inbound grants (results), so it needs the recipient consume policy too.
CREATE POLICY agent_grant_orchestrator_consume ON aegis.agent_grants FOR UPDATE TO aegis_orchestrator
  USING (to_agent = aegis.current_agent() AND status = 'open' AND expires_at > clock_timestamp())
  WITH CHECK (to_agent = aegis.current_agent() AND status = 'consumed' AND consumed_by_agent = aegis.current_agent());

-- Retrieval reads documents of the tenant it is serving.
GRANT SELECT ON aegis.documents, aegis.document_chunks TO aegis_retrieval;

-- Gateway: create the investigation, read it, and request cancellation. Tenant scope from the transaction.
GRANT SELECT, INSERT ON aegis.investigation_requests TO aegis_gateway;
GRANT SELECT ON aegis.investigation_results TO aegis_gateway;
GRANT INSERT ON aegis.investigation_requests TO aegis_gateway;

-- Orchestrator writes the final result of an investigation and reads its request.
GRANT SELECT ON aegis.investigation_requests TO aegis_orchestrator;
GRANT INSERT ON aegis.investigation_results TO aegis_orchestrator;
GRANT SELECT ON aegis.investigation_results TO aegis_orchestrator;

-- Roles that must not hold membership in one another, which the identity model depends on.
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['aegis_orchestrator', 'aegis_triage', 'aegis_retrieval', 'aegis_reviewer', 'aegis_gateway', 'aegis_operator']
  LOOP
    EXECUTE format('ALTER ROLE %I NOINHERIT', r);
  END LOOP;
END $$;
