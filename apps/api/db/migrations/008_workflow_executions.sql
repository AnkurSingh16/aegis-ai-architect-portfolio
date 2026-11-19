-- Additive only: two new tables for durable execution state and an append-only checkpoint log.
CREATE TABLE aegis.workflow_executions (
  execution_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES aegis.tenants (id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  state text NOT NULL CHECK (state IN ('pending', 'running', 'awaiting_approval', 'retry_wait', 'succeeded', 'failed', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 10),
  next_attempt_at timestamptz,
  lease_owner text CHECK (lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 200),
  lease_expires_at timestamptz,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  last_error_class text CHECK (last_error_class IS NULL OR last_error_class IN ('retryable', 'permanent', 'timeout', 'cancelled')),
  approval_id uuid,
  cancel_requested boolean NOT NULL DEFAULT false,
  approval_granted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  CHECK (state NOT IN ('succeeded', 'failed', 'cancelled') OR lease_owner IS NULL),
  CHECK (state <> 'awaiting_approval' OR (approval_id IS NOT NULL AND lease_owner IS NULL AND NOT approval_granted)),
  CHECK (NOT approval_granted OR approval_id IS NOT NULL),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE aegis.workflow_checkpoints (
  execution_id uuid NOT NULL REFERENCES aegis.workflow_executions (execution_id),
  tenant_id uuid NOT NULL REFERENCES aegis.tenants (id),
  seq integer NOT NULL CHECK (seq >= 1),
  state text NOT NULL CHECK (state IN ('pending', 'running', 'awaiting_approval', 'retry_wait', 'succeeded', 'failed', 'cancelled')),
  attempts integer NOT NULL CHECK (attempts BETWEEN 0 AND 10),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (execution_id, seq)
);

ALTER TABLE aegis.workflow_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE aegis.workflow_executions FORCE ROW LEVEL SECURITY;
ALTER TABLE aegis.workflow_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE aegis.workflow_checkpoints FORCE ROW LEVEL SECURITY;

CREATE POLICY workflow_execution_tenant_read ON aegis.workflow_executions FOR SELECT TO aegis_app
  USING (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid);
CREATE POLICY workflow_execution_tenant_insert ON aegis.workflow_executions FOR INSERT TO aegis_app
  WITH CHECK (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid AND state = 'pending' AND version = 0);
CREATE POLICY workflow_execution_tenant_update ON aegis.workflow_executions FOR UPDATE TO aegis_app
  USING (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid);

CREATE POLICY workflow_checkpoint_tenant_read ON aegis.workflow_checkpoints FOR SELECT TO aegis_app
  USING (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid);
CREATE POLICY workflow_checkpoint_tenant_insert ON aegis.workflow_checkpoints FOR INSERT TO aegis_app
  WITH CHECK (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid);

REVOKE ALL ON TABLE aegis.workflow_executions FROM PUBLIC, aegis_app;
REVOKE ALL ON TABLE aegis.workflow_checkpoints FROM PUBLIC, aegis_app;
GRANT SELECT ON aegis.workflow_executions TO aegis_app;
GRANT INSERT (tenant_id, idempotency_key, state, max_attempts) ON aegis.workflow_executions TO aegis_app;
GRANT UPDATE (state, attempts, next_attempt_at, lease_owner, lease_expires_at, version, last_error_class, updated_at, approval_id, cancel_requested, approval_granted)
  ON aegis.workflow_executions TO aegis_app;
GRANT SELECT ON aegis.workflow_checkpoints TO aegis_app;
GRANT INSERT (execution_id, tenant_id, seq, state, attempts) ON aegis.workflow_checkpoints TO aegis_app;

-- Checkpoints are append-only: no update or delete path exists for the application role.
CREATE FUNCTION aegis.forbid_checkpoint_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'workflow checkpoints are append-only' USING ERRCODE = '42501';
END;
$$;
REVOKE ALL ON FUNCTION aegis.forbid_checkpoint_change() FROM PUBLIC;
CREATE TRIGGER workflow_checkpoint_append_only BEFORE UPDATE OR DELETE ON aegis.workflow_checkpoints
  FOR EACH ROW EXECUTE FUNCTION aegis.forbid_checkpoint_change();
