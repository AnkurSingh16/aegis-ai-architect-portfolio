-- P4: durable multi-agent execution state. Additive only.
-- Persists the C8 contracts (apps/api/src/orchestration) as PostgreSQL rows. Every decision is made by the pure C8 rules inside one
-- transaction that holds the execution row lock; the constraints and triggers here are a second line of defence that does not depend
-- on application code being correct.
-- Time: every lease and grant decision uses clock_timestamp() on the database, never the worker's clock.

-- ---------------------------------------------------------------------------------------------------------------------------------
-- Agent registrations: the logical agents, bound to their P3 SPIFFE workload identities. Global catalogue, not tenant-owned.
-- Writes happen only through migrations and administrative roles. The runtime role can read it and nothing else.
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE aegis.agent_registrations (
  agent_id text PRIMARY KEY CHECK (agent_id ~ '^[a-z][a-z0-9_-]{1,31}$'),
  spiffe_id text NOT NULL UNIQUE CHECK (spiffe_id LIKE 'spiffe://aegis.local/workload/%'),
  role text NOT NULL CHECK (role IN ('orchestrator', 'triage', 'retrieval', 'reviewer')),
  registered_scopes text[] NOT NULL CHECK (cardinality(registered_scopes) BETWEEN 0 AND 16),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  CHECK (role <> 'orchestrator' OR agent_id = 'orchestrator')
);

-- Scopes are a ceiling per agent. No registration carries a write scope (C8 decision 2).
INSERT INTO aegis.agent_registrations (agent_id, spiffe_id, role, registered_scopes) VALUES
  ('orchestrator', 'spiffe://aegis.local/workload/orchestrator', 'orchestrator', ARRAY['case:read', 'document:read']),
  ('triage', 'spiffe://aegis.local/workload/triage', 'triage', ARRAY['case:read', 'document:read']),
  ('retrieval', 'spiffe://aegis.local/workload/retrieval', 'retrieval', ARRAY['document:read']),
  ('reviewer', 'spiffe://aegis.local/workload/reviewer', 'reviewer', ARRAY['case:read', 'document:read']);

-- ---------------------------------------------------------------------------------------------------------------------------------
-- Executions: one row per agent execution, owned by one tenant. Holds the originating principal reference (a digest, never the raw
-- subject), the principal scopes at start, the execution-wide budgets, the lease and the fencing token.
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE aegis.agent_executions (
  execution_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES aegis.tenants (id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  principal_ref text NOT NULL CHECK (principal_ref ~ '^[0-9a-f]{64}$'),
  principal_scopes text[] NOT NULL CHECK (cardinality(principal_scopes) BETWEEN 0 AND 16),
  root_agent text NOT NULL REFERENCES aegis.agent_registrations (agent_id) CHECK (root_agent = 'orchestrator'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
  max_depth integer NOT NULL CHECK (max_depth BETWEEN 1 AND 8),
  max_delegations integer NOT NULL CHECK (max_delegations BETWEEN 0 AND 100),
  max_steps integer NOT NULL CHECK (max_steps BETWEEN 1 AND 500),
  delegations_issued integer NOT NULL DEFAULT 0,
  steps_taken integer NOT NULL DEFAULT 0,
  grant_ttl_seconds integer NOT NULL DEFAULT 300 CHECK (grant_ttl_seconds BETWEEN 1 AND 3600),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 10),
  -- Incremented by every successful claim. A write carries the token it was granted; a stale token is refused.
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  lease_agent_id text REFERENCES aegis.agent_registrations (agent_id),
  lease_instance text CHECK (lease_instance IS NULL OR length(lease_instance) BETWEEN 1 AND 128),
  lease_expires_at timestamptz,
  cancel_requested boolean NOT NULL DEFAULT false,
  cancel_reason text CHECK (cancel_reason IS NULL OR length(cancel_reason) BETWEEN 1 AND 200),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((lease_agent_id IS NULL) = (lease_instance IS NULL)),
  CHECK ((lease_instance IS NULL) = (lease_expires_at IS NULL)),
  CHECK (delegations_issued BETWEEN 0 AND max_delegations),
  CHECK (steps_taken BETWEEN 0 AND max_steps),
  CHECK (attempts BETWEEN 0 AND max_attempts),
  CHECK (status NOT IN ('succeeded', 'failed', 'cancelled') OR lease_agent_id IS NULL),
  CHECK (NOT cancel_requested OR cancel_reason IS NOT NULL),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, execution_id)
);

-- ---------------------------------------------------------------------------------------------------------------------------------
-- Delegation hops. A chain is the ordered set of hops from the root to a branch's current holder, linked by parent_seq. Continuity
-- (the sender of a hop is the holder of its parent, and depth grows by one) is enforced by the trigger below, not only by the app.
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE aegis.agent_delegations (
  tenant_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  seq integer NOT NULL CHECK (seq >= 1),
  parent_seq integer,
  depth integer NOT NULL CHECK (depth BETWEEN 1 AND 8),
  from_agent text NOT NULL REFERENCES aegis.agent_registrations (agent_id),
  to_agent text NOT NULL REFERENCES aegis.agent_registrations (agent_id),
  effective_scopes text[] NOT NULL CHECK (cardinality(effective_scopes) <= 16),
  chain_digest text NOT NULL CHECK (chain_digest ~ '^[0-9a-f]{64}$'),
  fencing_token bigint NOT NULL CHECK (fencing_token >= 1),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (execution_id, seq),
  UNIQUE (execution_id, chain_digest),
  FOREIGN KEY (tenant_id, execution_id) REFERENCES aegis.agent_executions (tenant_id, execution_id),
  FOREIGN KEY (execution_id, parent_seq) REFERENCES aegis.agent_delegations (execution_id, seq),
  CHECK (from_agent <> to_agent),
  CHECK ((parent_seq IS NULL) = (depth = 1)),
  CHECK (parent_seq IS NULL OR parent_seq < seq)
);

CREATE FUNCTION aegis.check_delegation_continuity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, aegis AS $$
DECLARE
  root text;
  max_depth integer;
  parent_to text;
  parent_depth integer;
BEGIN
  SELECT e.root_agent, e.max_depth INTO root, max_depth
    FROM aegis.agent_executions e WHERE e.execution_id = NEW.execution_id AND e.tenant_id = NEW.tenant_id;
  IF NOT FOUND OR NEW.depth > max_depth THEN
    RAISE EXCEPTION 'delegation exceeds the execution depth limit' USING ERRCODE = '23514';
  END IF;
  IF NEW.parent_seq IS NULL THEN
    IF NEW.from_agent <> root THEN
      RAISE EXCEPTION 'delegation chain is discontinuous' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT d.to_agent, d.depth INTO parent_to, parent_depth
      FROM aegis.agent_delegations d WHERE d.execution_id = NEW.execution_id AND d.seq = NEW.parent_seq;
    IF NOT FOUND OR NEW.from_agent <> parent_to OR NEW.depth <> parent_depth + 1 THEN
      RAISE EXCEPTION 'delegation chain is discontinuous' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION aegis.check_delegation_continuity() FROM PUBLIC;
CREATE TRIGGER agent_delegation_continuity BEFORE INSERT ON aegis.agent_delegations
  FOR EACH ROW EXECUTE FUNCTION aegis.check_delegation_continuity();

-- ---------------------------------------------------------------------------------------------------------------------------------
-- Grants: single-use authorisation for one concrete envelope (C8 Grant). Status moves only open -> consumed or open -> revoked.
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE aegis.agent_grants (
  grant_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('request', 'result')),
  chain_digest text NOT NULL CHECK (chain_digest ~ '^[0-9a-f]{64}$'),
  depth integer NOT NULL CHECK (depth BETWEEN 1 AND 8),
  from_agent text NOT NULL REFERENCES aegis.agent_registrations (agent_id),
  to_agent text NOT NULL REFERENCES aegis.agent_registrations (agent_id),
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.:-]{0,63}$'),
  arguments_digest text NOT NULL CHECK (arguments_digest ~ '^[0-9a-f]{64}$'),
  required_scopes text[] NOT NULL CHECK (cardinality(required_scopes) <= 16),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'consumed', 'revoked')),
  issued_by_fencing_token bigint NOT NULL CHECK (issued_by_fencing_token >= 1),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  consumed_by_agent text REFERENCES aegis.agent_registrations (agent_id),
  consumed_by_fencing_token bigint,
  revoked_at timestamptz,
  FOREIGN KEY (tenant_id, execution_id) REFERENCES aegis.agent_executions (tenant_id, execution_id),
  CHECK (expires_at > issued_at),
  CHECK (from_agent <> to_agent),
  CHECK ((status = 'consumed') = (consumed_at IS NOT NULL)),
  CHECK ((status = 'consumed') = (consumed_by_agent IS NOT NULL)),
  CHECK ((status = 'consumed') = (consumed_by_fencing_token IS NOT NULL)),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);

-- At most one open grant per exact envelope: issuing the same grant twice (duplicate processing) is refused by the database.
CREATE UNIQUE INDEX agent_grants_one_open_per_envelope ON aegis.agent_grants
  (execution_id, kind, chain_digest, depth, from_agent, to_agent, action, arguments_digest) WHERE status = 'open';

CREATE FUNCTION aegis.forbid_grant_rebinding() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF (NEW.tenant_id, NEW.execution_id, NEW.kind, NEW.chain_digest, NEW.depth, NEW.from_agent, NEW.to_agent, NEW.action,
      NEW.arguments_digest, NEW.required_scopes, NEW.issued_at, NEW.expires_at, NEW.issued_by_fencing_token)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.execution_id, OLD.kind, OLD.chain_digest, OLD.depth, OLD.from_agent, OLD.to_agent, OLD.action,
      OLD.arguments_digest, OLD.required_scopes, OLD.issued_at, OLD.expires_at, OLD.issued_by_fencing_token) THEN
    RAISE EXCEPTION 'grant binding is immutable' USING ERRCODE = '42501';
  END IF;
  -- Only open -> consumed and open -> revoked are allowed. A final grant never changes again.
  IF OLD.status <> 'open' OR NEW.status NOT IN ('consumed', 'revoked') THEN
    RAISE EXCEPTION 'grant status is final' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION aegis.forbid_grant_rebinding() FROM PUBLIC;
CREATE TRIGGER agent_grant_immutable_binding BEFORE UPDATE ON aegis.agent_grants
  FOR EACH ROW EXECUTE FUNCTION aegis.forbid_grant_rebinding();

-- ---------------------------------------------------------------------------------------------------------------------------------
-- Audit events: append-only, one row per decision (accepted or refused), with no message content, arguments or subject.
-- ---------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE aegis.agent_execution_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES aegis.tenants (id),
  execution_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'execution_created', 'claimed', 'claim_refused', 'renewed', 'released', 'delegation_recorded', 'delegation_refused',
    'grant_issued', 'grant_refused', 'grant_consumed', 'grant_rejected', 'step_refused', 'fenced_write_refused',
    'cancel_requested', 'cancelled', 'succeeded', 'failed', 'retry_exhausted')),
  outcome text NOT NULL CHECK (outcome IN ('accepted', 'refused')),
  reason text CHECK (reason IS NULL OR reason ~ '^[a-z_]{1,40}$'),
  actor_agent text REFERENCES aegis.agent_registrations (agent_id),
  actor_instance text CHECK (actor_instance IS NULL OR length(actor_instance) BETWEEN 1 AND 128),
  fencing_token bigint CHECK (fencing_token IS NULL OR fencing_token >= 0),
  delegation_seq integer,
  grant_id uuid,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, execution_id) REFERENCES aegis.agent_executions (tenant_id, execution_id)
);

CREATE FUNCTION aegis.forbid_event_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'agent execution events are append-only' USING ERRCODE = '42501';
END;
$$;
REVOKE ALL ON FUNCTION aegis.forbid_event_change() FROM PUBLIC;
CREATE TRIGGER agent_execution_event_append_only BEFORE UPDATE OR DELETE ON aegis.agent_execution_events
  FOR EACH ROW EXECUTE FUNCTION aegis.forbid_event_change();

CREATE INDEX agent_execution_events_by_execution ON aegis.agent_execution_events (tenant_id, execution_id, event_id);
CREATE INDEX agent_grants_by_execution ON aegis.agent_grants (tenant_id, execution_id);
CREATE INDEX agent_executions_claimable ON aegis.agent_executions (tenant_id, status, lease_expires_at);

-- ---------------------------------------------------------------------------------------------------------------------------------
-- Row level security and least privilege. Every tenant-owned table is forced under RLS on the tenant of the transaction.
-- ---------------------------------------------------------------------------------------------------------------------------------
-- The catalogue is global, so it has no tenant predicate. It is still under forced RLS, with a read-only policy for the runtime role,
-- so every aegis table is governed the same way. Seed rows are inserted above, before FORCE applies to the owner.
ALTER TABLE aegis.agent_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE aegis.agent_registrations FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_registration_read ON aegis.agent_registrations FOR SELECT TO aegis_app USING (true);

ALTER TABLE aegis.agent_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE aegis.agent_executions FORCE ROW LEVEL SECURITY;
ALTER TABLE aegis.agent_delegations ENABLE ROW LEVEL SECURITY;
ALTER TABLE aegis.agent_delegations FORCE ROW LEVEL SECURITY;
ALTER TABLE aegis.agent_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE aegis.agent_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE aegis.agent_execution_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE aegis.agent_execution_events FORCE ROW LEVEL SECURITY;

CREATE POLICY agent_execution_tenant_read ON aegis.agent_executions FOR SELECT TO aegis_app
  USING (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid);
CREATE POLICY agent_execution_tenant_insert ON aegis.agent_executions FOR INSERT TO aegis_app
  WITH CHECK (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid
    AND status = 'pending' AND version = 0 AND fencing_token = 0 AND steps_taken = 0 AND delegations_issued = 0
    AND attempts = 0 AND lease_agent_id IS NULL AND NOT cancel_requested);
CREATE POLICY agent_execution_tenant_update ON aegis.agent_executions FOR UPDATE TO aegis_app
  USING (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid);

CREATE POLICY agent_delegation_tenant_read ON aegis.agent_delegations FOR SELECT TO aegis_app
  USING (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid);
CREATE POLICY agent_delegation_tenant_insert ON aegis.agent_delegations FOR INSERT TO aegis_app
  WITH CHECK (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid);

CREATE POLICY agent_grant_tenant_read ON aegis.agent_grants FOR SELECT TO aegis_app
  USING (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid);
CREATE POLICY agent_grant_tenant_insert ON aegis.agent_grants FOR INSERT TO aegis_app
  WITH CHECK (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid AND status = 'open');
CREATE POLICY agent_grant_tenant_update ON aegis.agent_grants FOR UPDATE TO aegis_app
  USING (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid);

CREATE POLICY agent_event_tenant_read ON aegis.agent_execution_events FOR SELECT TO aegis_app
  USING (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid);
CREATE POLICY agent_event_tenant_insert ON aegis.agent_execution_events FOR INSERT TO aegis_app
  WITH CHECK (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid);

REVOKE ALL ON TABLE aegis.agent_registrations FROM PUBLIC, aegis_app;
REVOKE ALL ON TABLE aegis.agent_executions FROM PUBLIC, aegis_app;
REVOKE ALL ON TABLE aegis.agent_delegations FROM PUBLIC, aegis_app;
REVOKE ALL ON TABLE aegis.agent_grants FROM PUBLIC, aegis_app;
REVOKE ALL ON TABLE aegis.agent_execution_events FROM PUBLIC, aegis_app;

GRANT SELECT ON aegis.agent_registrations TO aegis_app;

GRANT SELECT, INSERT (tenant_id, idempotency_key, principal_ref, principal_scopes, root_agent, status, max_depth, max_delegations,
  max_steps, grant_ttl_seconds, max_attempts, version, fencing_token, attempts, steps_taken, delegations_issued, cancel_requested)
  ON aegis.agent_executions TO aegis_app;
GRANT SELECT ON aegis.agent_executions TO aegis_app;
GRANT UPDATE (status, delegations_issued, steps_taken, attempts, fencing_token, lease_agent_id, lease_instance, lease_expires_at,
  cancel_requested, cancel_reason, version, updated_at) ON aegis.agent_executions TO aegis_app;

GRANT SELECT, INSERT ON aegis.agent_delegations TO aegis_app;

GRANT SELECT, INSERT ON aegis.agent_grants TO aegis_app;
GRANT UPDATE (status, consumed_at, consumed_by_agent, consumed_by_fencing_token, revoked_at) ON aegis.agent_grants TO aegis_app;

GRANT SELECT, INSERT ON aegis.agent_execution_events TO aegis_app;
GRANT USAGE ON SEQUENCE aegis.agent_execution_events_event_id_seq TO aegis_app;
