-- Additive only: creates a new table. Does not alter or drop existing objects.
CREATE TABLE aegis.tool_approvals (
  approval_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  tool_name text NOT NULL CHECK (length(tool_name) BETWEEN 1 AND 120),
  action_digest text NOT NULL CHECK (action_digest ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'consumed')),
  requested_by text NOT NULL CHECK (length(requested_by) BETWEEN 1 AND 255),
  approved_by text CHECK (approved_by IS NULL OR length(approved_by) BETWEEN 1 AND 255),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_at timestamptz,
  consumed_at timestamptz,
  CHECK (status <> 'approved' OR approved_by IS NOT NULL),
  CHECK (approved_by IS NULL OR approved_by <> requested_by),
  CHECK (status <> 'consumed' OR consumed_at IS NOT NULL),
  CHECK (consumed_at IS NULL OR status = 'consumed'),
  FOREIGN KEY (tenant_id) REFERENCES aegis.tenants (id)
);
CREATE INDEX tool_approvals_tenant_status ON aegis.tool_approvals (tenant_id, status, expires_at);

ALTER TABLE aegis.tool_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE aegis.tool_approvals FORCE ROW LEVEL SECURITY;

CREATE POLICY tool_approval_tenant_read ON aegis.tool_approvals FOR SELECT TO aegis_app
  USING (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid);

CREATE POLICY tool_approval_tenant_insert ON aegis.tool_approvals FOR INSERT TO aegis_app
  WITH CHECK (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid AND status = 'pending');

CREATE POLICY tool_approval_tenant_update ON aegis.tool_approvals FOR UPDATE TO aegis_app
  USING (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid);

REVOKE ALL ON TABLE aegis.tool_approvals FROM PUBLIC, aegis_app;
GRANT SELECT ON aegis.tool_approvals TO aegis_app;
GRANT INSERT (tenant_id, tool_name, action_digest, status, requested_by, expires_at) ON aegis.tool_approvals TO aegis_app;
-- Only the decision and consumption columns can change after creation.
GRANT UPDATE (status, approved_by, decided_at, consumed_at) ON aegis.tool_approvals TO aegis_app;

-- Database-level guard: only the legal status transitions, and immutable identity fields after creation.
CREATE FUNCTION aegis.enforce_tool_approval_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.tool_name IS DISTINCT FROM OLD.tool_name
    OR NEW.action_digest IS DISTINCT FROM OLD.action_digest OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'tool approval identity is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND (OLD.status, NEW.status) NOT IN
    (('pending', 'approved'), ('pending', 'rejected'), ('approved', 'consumed')) THEN
    RAISE EXCEPTION 'illegal tool approval transition' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION aegis.enforce_tool_approval_transition() FROM PUBLIC;
CREATE TRIGGER tool_approval_transition BEFORE UPDATE ON aegis.tool_approvals
  FOR EACH ROW EXECUTE FUNCTION aegis.enforce_tool_approval_transition();
