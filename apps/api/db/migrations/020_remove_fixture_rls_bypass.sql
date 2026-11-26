-- P8 security hardening, remediation 1: remove the fixture-mode RLS bypass from the application runtime role.
-- Additive. Migrations 001-019 are not changed.
--
-- Before this migration, the policies on aegis.tenants, aegis.support_cases and aegis.audit_events (defined in 002) accepted rows for
-- aegis_app whenever the session setting aegis.access_mode was 'fixture', without any membership check. Any SQL run as aegis_app could
-- set that setting and read or write another tenant's rows. The setting is not a credential; it is an ordinary session value.
--
-- After this migration:
-- - aegis_app is subject only to the 'authenticated' policies: a verified principal, a membership, and the tenant set by the
--   application after membership is checked. The fixture branch is gone from every runtime policy.
-- - Local synthetic persistence (the development CLI and its tests) uses a separate role, aegis_fixture. It is NOLOGIN, has no
--   membership in any other role, and its policies apply only to that role. No application login can become it: SET ROLE requires
--   membership, and membership is granted only by the administrator. Provisioning a login for aegis_fixture is an administrator action
--   outside this migration.
-- - FORCE ROW LEVEL SECURITY stays enabled on all three tables (001), so the table owner is also subject to the policies.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aegis_fixture') THEN
    CREATE ROLE aegis_fixture NOLOGIN NOINHERIT NOCREATEROLE NOCREATEDB NOBYPASSRLS;
  END IF;
END
$$;

-- Runtime policies without the fixture branch. Same predicates as 002, minus the fixture alternative.
DROP POLICY tenant_scope ON aegis.tenants;
CREATE POLICY tenant_scope ON aegis.tenants TO aegis_app
  USING (id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid
    AND current_setting('aegis.access_mode', true) = 'authenticated'
    AND EXISTS (SELECT 1 FROM aegis.memberships m WHERE m.tenant_id = tenants.id))
  WITH CHECK (id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid
    AND current_setting('aegis.access_mode', true) = 'authenticated'
    AND EXISTS (SELECT 1 FROM aegis.memberships m WHERE m.tenant_id = tenants.id));

DROP POLICY case_scope ON aegis.support_cases;
CREATE POLICY case_scope ON aegis.support_cases TO aegis_app
  USING (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid
    AND current_setting('aegis.access_mode', true) = 'authenticated'
    AND EXISTS (SELECT 1 FROM aegis.memberships m WHERE m.tenant_id = support_cases.tenant_id))
  WITH CHECK (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid
    AND current_setting('aegis.access_mode', true) = 'authenticated'
    AND EXISTS (SELECT 1 FROM aegis.memberships m WHERE m.tenant_id = support_cases.tenant_id AND m.role = 'operator'));

DROP POLICY audit_scope ON aegis.audit_events;
CREATE POLICY audit_scope ON aegis.audit_events TO aegis_app
  USING (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid
    AND current_setting('aegis.access_mode', true) = 'authenticated'
    AND EXISTS (SELECT 1 FROM aegis.memberships m WHERE m.tenant_id = audit_events.tenant_id))
  WITH CHECK (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid
    AND current_setting('aegis.access_mode', true) = 'authenticated'
    AND EXISTS (SELECT 1 FROM aegis.memberships m WHERE m.tenant_id = audit_events.tenant_id AND m.role = 'operator'));

-- Fixture role: synthetic local persistence only. Reachable only when the fixture role itself is the session role.
GRANT USAGE ON SCHEMA aegis TO aegis_fixture;
GRANT SELECT, INSERT, UPDATE ON aegis.tenants, aegis.support_cases, aegis.audit_events TO aegis_fixture;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA aegis TO aegis_fixture;

CREATE POLICY fixture_tenant_scope ON aegis.tenants TO aegis_fixture
  USING (id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid AND current_setting('aegis.access_mode', true) = 'fixture')
  WITH CHECK (id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid AND current_setting('aegis.access_mode', true) = 'fixture');
CREATE POLICY fixture_case_scope ON aegis.support_cases TO aegis_fixture
  USING (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid AND current_setting('aegis.access_mode', true) = 'fixture')
  WITH CHECK (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid AND current_setting('aegis.access_mode', true) = 'fixture');
CREATE POLICY fixture_audit_scope ON aegis.audit_events TO aegis_fixture
  USING (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid AND current_setting('aegis.access_mode', true) = 'fixture')
  WITH CHECK (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid AND current_setting('aegis.access_mode', true) = 'fixture');
