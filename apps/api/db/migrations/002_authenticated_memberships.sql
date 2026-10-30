CREATE TABLE aegis.memberships (
  issuer text NOT NULL CHECK (length(issuer) BETWEEN 1 AND 255),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
  tenant_id uuid NOT NULL REFERENCES aegis.tenants(id),
  role text NOT NULL CHECK (role IN ('reader', 'operator')),
  PRIMARY KEY (issuer, subject, tenant_id)
);
ALTER TABLE aegis.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE aegis.memberships FORCE ROW LEVEL SECURITY;
GRANT SELECT ON aegis.memberships TO aegis_app;

-- Lookup is scoped by verified principal, before tenant context is established.
CREATE POLICY principal_memberships ON aegis.memberships FOR SELECT TO aegis_app
  USING (current_setting('aegis.access_mode', true) = 'authenticated'
    AND issuer = current_setting('aegis.principal_issuer', true)
    AND subject = current_setting('aegis.principal_subject', true));

DROP POLICY tenant_scope ON aegis.tenants;
DROP POLICY case_scope ON aegis.support_cases;
DROP POLICY audit_scope ON aegis.audit_events;

CREATE POLICY tenant_scope ON aegis.tenants TO aegis_app
  USING (id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid
    AND (current_setting('aegis.access_mode', true) = 'fixture'
      OR (current_setting('aegis.access_mode', true) = 'authenticated'
        AND EXISTS (SELECT 1 FROM aegis.memberships m WHERE m.tenant_id = tenants.id))))
  WITH CHECK (id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid
    AND (current_setting('aegis.access_mode', true) = 'fixture'
      OR (current_setting('aegis.access_mode', true) = 'authenticated'
        AND EXISTS (SELECT 1 FROM aegis.memberships m WHERE m.tenant_id = tenants.id))));

CREATE POLICY case_scope ON aegis.support_cases TO aegis_app
  USING (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid
    AND (current_setting('aegis.access_mode', true) = 'fixture'
      OR (current_setting('aegis.access_mode', true) = 'authenticated'
        AND EXISTS (SELECT 1 FROM aegis.memberships m WHERE m.tenant_id = support_cases.tenant_id))))
  WITH CHECK (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid
    AND (current_setting('aegis.access_mode', true) = 'fixture'
      OR (current_setting('aegis.access_mode', true) = 'authenticated'
        AND EXISTS (SELECT 1 FROM aegis.memberships m WHERE m.tenant_id = support_cases.tenant_id AND m.role = 'operator'))));

CREATE POLICY audit_scope ON aegis.audit_events TO aegis_app
  USING (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid
    AND (current_setting('aegis.access_mode', true) = 'fixture'
      OR (current_setting('aegis.access_mode', true) = 'authenticated'
        AND EXISTS (SELECT 1 FROM aegis.memberships m WHERE m.tenant_id = audit_events.tenant_id))))
  WITH CHECK (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid
    AND (current_setting('aegis.access_mode', true) = 'fixture'
      OR (current_setting('aegis.access_mode', true) = 'authenticated'
        AND EXISTS (SELECT 1 FROM aegis.memberships m WHERE m.tenant_id = audit_events.tenant_id AND m.role = 'operator'))));
