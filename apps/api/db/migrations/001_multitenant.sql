CREATE SCHEMA aegis;
REVOKE ALL ON SCHEMA aegis FROM PUBLIC;

CREATE TABLE aegis.tenants (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (name IN ('Synthetic North', 'Synthetic South'))
);

CREATE TABLE aegis.support_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES aegis.tenants(id),
  synthetic_case_id text NOT NULL CHECK (synthetic_case_id IN
    ('SYNTHETIC-LOGIN-001', 'SYNTHETIC-BILLING-002', 'SYNTHETIC-GUIDANCE-003')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX support_cases_tenant_created ON aegis.support_cases (tenant_id, created_at, id);

CREATE TABLE aegis.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES aegis.tenants(id),
  case_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('case.created', 'case.updated')),
  previous_status text CHECK (previous_status IN ('open', 'in_progress', 'resolved')),
  new_status text NOT NULL CHECK (new_status IN ('open', 'in_progress', 'resolved')),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, case_id) REFERENCES aegis.support_cases(tenant_id, id)
);
CREATE INDEX audit_events_tenant_case ON aegis.audit_events (tenant_id, case_id, occurred_at);

ALTER TABLE aegis.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE aegis.tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE aegis.support_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE aegis.support_cases FORCE ROW LEVEL SECURITY;
ALTER TABLE aegis.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE aegis.audit_events FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_scope ON aegis.tenants TO aegis_app
  USING (id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid);
CREATE POLICY case_scope ON aegis.support_cases TO aegis_app
  USING (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid);
CREATE POLICY audit_scope ON aegis.audit_events TO aegis_app
  USING (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid);

-- The trigger owns audit insertion; callers cannot supply or edit audit records.
CREATE FUNCTION aegis.record_case_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM NULLIF(current_setting('aegis.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'Tenant context required' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    NEW.updated_at := clock_timestamp();
  END IF;
  INSERT INTO aegis.audit_events (tenant_id, case_id, action, previous_status, new_status)
  VALUES (NEW.tenant_id, NEW.id,
    CASE WHEN TG_OP = 'INSERT' THEN 'case.created' ELSE 'case.updated' END,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.status ELSE NULL END, NEW.status);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION aegis.record_case_change() FROM PUBLIC;
-- AFTER INSERT ensures the audit foreign key sees the new case.
CREATE TRIGGER case_created AFTER INSERT ON aegis.support_cases
  FOR EACH ROW EXECUTE FUNCTION aegis.record_case_change();
CREATE TRIGGER case_updated BEFORE UPDATE ON aegis.support_cases
  FOR EACH ROW EXECUTE FUNCTION aegis.record_case_change();

GRANT USAGE ON SCHEMA aegis TO aegis_app;
GRANT SELECT ON aegis.tenants, aegis.support_cases, aegis.audit_events TO aegis_app;
GRANT INSERT (tenant_id, synthetic_case_id) ON aegis.support_cases TO aegis_app;
GRANT UPDATE (status) ON aegis.support_cases TO aegis_app;

INSERT INTO aegis.tenants (id, name) VALUES
  ('10000000-0000-4000-8000-000000000001', 'Synthetic North'),
  ('20000000-0000-4000-8000-000000000002', 'Synthetic South');
