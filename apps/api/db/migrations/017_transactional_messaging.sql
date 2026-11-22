-- P5: transactional outbox, dispatcher leases and transactional inbox for agent-to-agent messages. Additive only.
-- Authority is never carried by a message. A message is a transport for an envelope that the C8 rules authorise against a single-use
-- grant (agent_grants, migration 016). Every outbound message is inserted in the same transaction as the P4 decision that produced it,
-- so a rolled-back decision leaves no deliverable message and a committed decision cannot leave one out.
-- Time: every lease, backoff and delivery timestamp uses clock_timestamp() on the database, never a worker clock.

-- ---------------------------------------------------------------------------------------------------------------------------------
-- Outbox. One row per outbound message. Lifecycle: pending -> leased -> delivered, with leased -> pending (retry with backoff) and
-- leased -> dead (retry budget exhausted or a permanent refusal). dead -> pending only through the audited operator requeue.
-- The envelope and payload are immutable once written. Only the lifecycle columns change.
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE aegis.agent_outbox (
  message_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES aegis.tenants (id),
  execution_id uuid NOT NULL,
  sender_agent text NOT NULL REFERENCES aegis.agent_registrations (agent_id),
  destination_agent text NOT NULL REFERENCES aegis.agent_registrations (agent_id),
  kind text NOT NULL CHECK (kind IN ('request', 'result')),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  -- The C8 envelope: ten fixed fields, no arguments and no authority. The payload carries bounded arguments or result data.
  envelope jsonb NOT NULL CHECK (jsonb_typeof(envelope) = 'object' AND octet_length(envelope::text) <= 4096),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 8192),
  -- sha256 of the canonical payload. The receiver recomputes it before it authorises anything.
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'leased', 'delivered', 'dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 50),
  max_attempts integer NOT NULL DEFAULT 6 CHECK (max_attempts BETWEEN 1 AND 20),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- Incremented by every claim. An acknowledgement or a failure carries the token it was leased under; a stale token is refused.
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  lease_instance text CHECK (lease_instance IS NULL OR length(lease_instance) BETWEEN 1 AND 128),
  lease_expires_at timestamptz,
  last_error text CHECK (last_error IS NULL OR last_error ~ '^[a-z_]{1,40}$'),
  delivered_at timestamptz,
  dead_at timestamptz,
  dead_reason text CHECK (dead_reason IS NULL OR dead_reason ~ '^[a-z_]{1,40}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, execution_id) REFERENCES aegis.agent_executions (tenant_id, execution_id),
  CHECK (sender_agent <> destination_agent),
  CHECK ((status = 'leased') = (lease_instance IS NOT NULL)),
  CHECK ((status = 'leased') = (lease_expires_at IS NOT NULL)),
  CHECK ((status = 'delivered') = (delivered_at IS NOT NULL)),
  CHECK ((status = 'dead') = (dead_at IS NOT NULL)),
  CHECK ((status = 'dead') = (dead_reason IS NOT NULL)),
  CHECK (attempts <= max_attempts OR status = 'dead'),
  CHECK (fencing_token >= attempts)
);

-- The dispatcher's claim scans only undelivered rows for its sender. Partial index keeps the claim cost independent of history.
CREATE INDEX agent_outbox_claimable ON aegis.agent_outbox (sender_agent, next_attempt_at)
  WHERE status IN ('pending', 'leased');
CREATE INDEX agent_outbox_by_execution ON aegis.agent_outbox (tenant_id, execution_id);
CREATE INDEX agent_outbox_dead ON aegis.agent_outbox (tenant_id, dead_at) WHERE status = 'dead';
CREATE INDEX agent_outbox_delivered ON aegis.agent_outbox (tenant_id, delivered_at) WHERE status = 'delivered';

CREATE FUNCTION aegis.forbid_outbox_rebinding() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF (NEW.message_id, NEW.tenant_id, NEW.execution_id, NEW.sender_agent, NEW.destination_agent, NEW.kind, NEW.schema_version,
      NEW.envelope, NEW.payload, NEW.payload_digest, NEW.created_at)
     IS DISTINCT FROM
     (OLD.message_id, OLD.tenant_id, OLD.execution_id, OLD.sender_agent, OLD.destination_agent, OLD.kind, OLD.schema_version,
      OLD.envelope, OLD.payload, OLD.payload_digest, OLD.created_at) THEN
    RAISE EXCEPTION 'outbound message content is immutable' USING ERRCODE = '42501';
  END IF;
  -- Delivered is final. A dead message only moves back to pending through the operator requeue (which also clears dead_*).
  IF OLD.status = 'delivered' THEN
    RAISE EXCEPTION 'delivered message is final' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'dead' AND NOT (NEW.status = 'pending' AND NEW.dead_at IS NULL AND NEW.dead_reason IS NULL) THEN
    RAISE EXCEPTION 'dead message only moves through requeue' USING ERRCODE = '42501';
  END IF;
  -- A lease can only grow its fencing token, and the attempt counter only grows.
  IF NEW.fencing_token < OLD.fencing_token OR NEW.attempts < OLD.attempts OR NEW.max_attempts < OLD.max_attempts THEN
    RAISE EXCEPTION 'outbox counters never decrease' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION aegis.forbid_outbox_rebinding() FROM PUBLIC;
CREATE TRIGGER agent_outbox_immutable BEFORE UPDATE ON aegis.agent_outbox
  FOR EACH ROW EXECUTE FUNCTION aegis.forbid_outbox_rebinding();

-- ---------------------------------------------------------------------------------------------------------------------------------
-- Inbox. One row per (receiving agent, message). The unique key is the deduplication guarantee: a repeated delivery finds the row
-- and returns its stored outcome, and concurrent deliveries serialise on the unique index. The row is written first, in the same
-- transaction as the grant consumption and the result message, so a rolled-back attempt leaves no row behind.
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE aegis.agent_inbox (
  receiver_agent text NOT NULL REFERENCES aegis.agent_registrations (agent_id),
  message_id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES aegis.tenants (id),
  execution_id uuid NOT NULL,
  -- The sender is the SPIFFE-verified peer resolved to its registration, never a value copied from the message.
  sender_agent text NOT NULL REFERENCES aegis.agent_registrations (agent_id),
  kind text NOT NULL CHECK (kind IN ('request', 'result')),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  outcome text NOT NULL DEFAULT 'received' CHECK (outcome IN ('received', 'processed', 'refused')),
  refusal_reason text CHECK (refusal_reason IS NULL OR refusal_reason ~ '^[a-z_]{1,40}$'),
  grant_id uuid REFERENCES aegis.agent_grants (grant_id),
  -- Reference to the result message this receipt produced. Plain value: the outbox row may be purged after delivery.
  result_message_id uuid,
  result_digest text CHECK (result_digest IS NULL OR result_digest ~ '^[0-9a-f]{64}$'),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_at timestamptz,
  PRIMARY KEY (receiver_agent, message_id),
  FOREIGN KEY (tenant_id, execution_id) REFERENCES aegis.agent_executions (tenant_id, execution_id),
  CHECK ((outcome = 'processed') = (grant_id IS NOT NULL AND result_digest IS NOT NULL)),
  CHECK ((outcome = 'refused') = (refusal_reason IS NOT NULL)),
  CHECK ((outcome = 'received') = (decided_at IS NULL)),
  CHECK (receiver_agent <> sender_agent)
);

CREATE INDEX agent_inbox_by_execution ON aegis.agent_inbox (tenant_id, execution_id);

CREATE FUNCTION aegis.forbid_inbox_rebinding() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF (NEW.receiver_agent, NEW.message_id, NEW.tenant_id, NEW.execution_id, NEW.sender_agent, NEW.kind, NEW.payload_digest, NEW.received_at)
     IS DISTINCT FROM
     (OLD.receiver_agent, OLD.message_id, OLD.tenant_id, OLD.execution_id, OLD.sender_agent, OLD.kind, OLD.payload_digest, OLD.received_at) THEN
    RAISE EXCEPTION 'inbox receipt identity is immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.outcome <> 'received' THEN
    RAISE EXCEPTION 'inbox outcome is final' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION aegis.forbid_inbox_rebinding() FROM PUBLIC;
CREATE TRIGGER agent_inbox_immutable BEFORE UPDATE ON aegis.agent_inbox
  FOR EACH ROW EXECUTE FUNCTION aegis.forbid_inbox_rebinding();

-- ---------------------------------------------------------------------------------------------------------------------------------
-- Message audit and operator actions. Append-only, with no content: identifiers, states, bounded reasons and fencing tokens.
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE aegis.agent_message_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES aegis.tenants (id),
  execution_id uuid NOT NULL,
  message_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('enqueued', 'leased', 'delivered', 'retry_scheduled', 'dead_lettered',
    'ack_refused', 'requeued', 'inbox_processed', 'inbox_duplicate', 'inbox_refused', 'purged')),
  actor_agent text REFERENCES aegis.agent_registrations (agent_id),
  fencing_token bigint CHECK (fencing_token IS NULL OR fencing_token >= 0),
  reason text CHECK (reason IS NULL OR reason ~ '^[a-z_]{1,40}$'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX agent_message_events_by_message ON aegis.agent_message_events (tenant_id, message_id, event_id);

CREATE TABLE aegis.agent_outbox_actions (
  action_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES aegis.tenants (id),
  message_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('requeue')),
  -- Digest of the operator identity and a bounded reason. The operator's name is never stored in clear.
  operator_ref text NOT NULL CHECK (operator_ref ~ '^[0-9a-f]{64}$'),
  reason text NOT NULL CHECK (reason ~ '^[a-z_]{1,40}$'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION aegis.forbid_message_audit_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'message audit is append-only' USING ERRCODE = '42501';
END;
$$;
REVOKE ALL ON FUNCTION aegis.forbid_message_audit_change() FROM PUBLIC;
CREATE TRIGGER agent_message_event_append_only BEFORE UPDATE OR DELETE ON aegis.agent_message_events
  FOR EACH ROW EXECUTE FUNCTION aegis.forbid_message_audit_change();
CREATE TRIGGER agent_outbox_action_append_only BEFORE UPDATE OR DELETE ON aegis.agent_outbox_actions
  FOR EACH ROW EXECUTE FUNCTION aegis.forbid_message_audit_change();

-- ---------------------------------------------------------------------------------------------------------------------------------
-- Row level security and least privilege.
-- Tenant scope: the transaction's tenant (aegis.tenant_id), as in migration 016.
-- Dispatch scope: a dispatcher sees and updates only messages whose sender is its own verified agent (aegis.agent_id), across tenants.
-- That is the one cross-tenant path, and it is limited to the rows its sender produced and to lifecycle columns (see GRANT below).
-- Both settings are set per transaction by the runtime from verified identity and never from message content.
-- ---------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE aegis.agent_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE aegis.agent_outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE aegis.agent_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE aegis.agent_inbox FORCE ROW LEVEL SECURITY;
ALTER TABLE aegis.agent_message_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE aegis.agent_message_events FORCE ROW LEVEL SECURITY;
ALTER TABLE aegis.agent_outbox_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE aegis.agent_outbox_actions FORCE ROW LEVEL SECURITY;

CREATE POLICY agent_outbox_tenant_read ON aegis.agent_outbox FOR SELECT TO aegis_app
  USING (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid);
CREATE POLICY agent_outbox_tenant_insert ON aegis.agent_outbox FOR INSERT TO aegis_app
  WITH CHECK (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid
    AND status = 'pending' AND attempts = 0 AND fencing_token = 0 AND lease_instance IS NULL AND delivered_at IS NULL AND dead_at IS NULL);
CREATE POLICY agent_outbox_tenant_requeue ON aegis.agent_outbox FOR UPDATE TO aegis_app
  USING (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid AND status = 'dead')
  WITH CHECK (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid);
CREATE POLICY agent_outbox_dispatch_select ON aegis.agent_outbox FOR SELECT TO aegis_app
  USING (sender_agent = NULLIF(current_setting('aegis.agent_id', true), ''));
CREATE POLICY agent_outbox_dispatch_update ON aegis.agent_outbox FOR UPDATE TO aegis_app
  USING (sender_agent = NULLIF(current_setting('aegis.agent_id', true), ''))
  WITH CHECK (sender_agent = NULLIF(current_setting('aegis.agent_id', true), ''));
CREATE POLICY agent_outbox_tenant_purge ON aegis.agent_outbox FOR DELETE TO aegis_app
  USING (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid AND status = 'delivered');

CREATE POLICY agent_inbox_tenant_read ON aegis.agent_inbox FOR SELECT TO aegis_app
  USING (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid);
CREATE POLICY agent_inbox_tenant_insert ON aegis.agent_inbox FOR INSERT TO aegis_app
  WITH CHECK (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid AND outcome = 'received' AND decided_at IS NULL
    AND receiver_agent = NULLIF(current_setting('aegis.agent_id', true), ''));
CREATE POLICY agent_inbox_tenant_update ON aegis.agent_inbox FOR UPDATE TO aegis_app
  USING (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid
    AND receiver_agent = NULLIF(current_setting('aegis.agent_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid
    AND receiver_agent = NULLIF(current_setting('aegis.agent_id', true), ''));

CREATE POLICY agent_message_event_tenant_read ON aegis.agent_message_events FOR SELECT TO aegis_app
  USING (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid);
CREATE POLICY agent_message_event_tenant_insert ON aegis.agent_message_events FOR INSERT TO aegis_app
  WITH CHECK (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid);

CREATE POLICY agent_outbox_action_tenant_read ON aegis.agent_outbox_actions FOR SELECT TO aegis_app
  USING (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid);
CREATE POLICY agent_outbox_action_tenant_insert ON aegis.agent_outbox_actions FOR INSERT TO aegis_app
  WITH CHECK (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid);

REVOKE ALL ON TABLE aegis.agent_outbox FROM PUBLIC, aegis_app;
REVOKE ALL ON TABLE aegis.agent_inbox FROM PUBLIC, aegis_app;
REVOKE ALL ON TABLE aegis.agent_message_events FROM PUBLIC, aegis_app;
REVOKE ALL ON TABLE aegis.agent_outbox_actions FROM PUBLIC, aegis_app;

-- Column-level grants. The runtime cannot change identity, envelope, payload or digest columns even if a policy were wrong.
GRANT SELECT, INSERT ON aegis.agent_outbox TO aegis_app;
GRANT UPDATE (status, attempts, max_attempts, next_attempt_at, fencing_token, lease_instance, lease_expires_at, last_error, delivered_at,
  dead_at, dead_reason, updated_at) ON aegis.agent_outbox TO aegis_app;
GRANT DELETE ON aegis.agent_outbox TO aegis_app;

GRANT SELECT, INSERT ON aegis.agent_inbox TO aegis_app;
GRANT UPDATE (outcome, refusal_reason, grant_id, result_message_id, result_digest, decided_at) ON aegis.agent_inbox TO aegis_app;

GRANT SELECT, INSERT ON aegis.agent_message_events TO aegis_app;
GRANT USAGE ON SEQUENCE aegis.agent_message_events_event_id_seq TO aegis_app;
GRANT SELECT, INSERT ON aegis.agent_outbox_actions TO aegis_app;
GRANT USAGE ON SEQUENCE aegis.agent_outbox_actions_action_id_seq TO aegis_app;
