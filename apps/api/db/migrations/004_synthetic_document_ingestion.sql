GRANT USAGE ON SCHEMA aegis, aegis_migrations TO aegis_ingest;

-- These immutable manifest checks prevent a database credential from bypassing CLI validation.
-- They expose only a boolean and accept only the catalog's exact tenant/source/version/bytes.
CREATE FUNCTION aegis_migrations.synthetic_document_is_approved(
  p_tenant uuid, p_source text, p_version integer, p_revision text, p_hash text, p_metadata jsonb)
RETURNS boolean LANGUAGE SQL IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
  SELECT (p_tenant,p_source,p_version,p_revision,p_hash,p_metadata) IN (VALUES
    ('10000000-0000-4000-8000-000000000001'::uuid,'SYNTHETIC-NORTH-LOGIN-INCIDENT',1,'aegis-support-docs-v1','5d6bf61801302ce015412489a20a2e8d47275938f5faf2f0bb74cd5cc7e34d8f','{"title":"Synthetic login incident checklist","contentType":"text/plain","sourceKind":"synthetic_support_procedure"}'::jsonb),
    ('10000000-0000-4000-8000-000000000001'::uuid,'SYNTHETIC-NORTH-MFA-GUIDANCE',1,'aegis-support-docs-v1','e5ebccab6bc43873ec1541271bec892fb0b7df4940ebbd0b56a874a35a3d52f6','{"title":"Synthetic MFA troubleshooting guidance","contentType":"text/plain","sourceKind":"synthetic_support_procedure"}'::jsonb),
    ('10000000-0000-4000-8000-000000000001'::uuid,'SYNTHETIC-NORTH-ACCOUNT-RECOVERY',1,'aegis-support-docs-v1','d48aa435533b12493d20887c198ec65f404d8efff5cfc63c2f75dad32653872c','{"title":"Synthetic account recovery procedure","contentType":"text/plain","sourceKind":"synthetic_support_procedure"}'::jsonb),
    ('10000000-0000-4000-8000-000000000001'::uuid,'SYNTHETIC-NORTH-NETWORK-DIAGNOSTICS',1,'aegis-support-docs-v1','689e0cf0a89aec39320510043eac25f9c1b7653014fa14271de166305aab3d33','{"title":"Synthetic network diagnostics","contentType":"text/plain","sourceKind":"synthetic_support_procedure"}'::jsonb),
    ('20000000-0000-4000-8000-000000000002'::uuid,'SYNTHETIC-SOUTH-BILLING-DISCREPANCY',1,'aegis-support-docs-v1','9e91cdcdc91d6363eb1187d3ea9358a5bc7ada9261b1eaf3c105699c06abe5a7','{"title":"Synthetic billing discrepancy review","contentType":"text/plain","sourceKind":"synthetic_support_procedure"}'::jsonb),
    ('20000000-0000-4000-8000-000000000002'::uuid,'SYNTHETIC-SOUTH-SERVICE-DEGRADATION',1,'aegis-support-docs-v1','7782b3892727def95c81f2e10c49f6b60ab05be2f500f5354dc8e2d594196b75','{"title":"Synthetic service degradation triage","contentType":"text/plain","sourceKind":"synthetic_support_procedure"}'::jsonb),
    ('20000000-0000-4000-8000-000000000002'::uuid,'SYNTHETIC-SOUTH-SUPPORT-ESCALATION',1,'aegis-support-docs-v1','9d61efa0c00a896a8d00197460b2e2f768c30876a59d58ef9440266eac8dade7','{"title":"Synthetic support escalation guide","contentType":"text/plain","sourceKind":"synthetic_support_procedure"}'::jsonb),
    ('20000000-0000-4000-8000-000000000002'::uuid,'SYNTHETIC-SOUTH-GENERAL-GUIDANCE',1,'aegis-support-docs-v1','78fab84d22b898436fb80780b095f4fd0faf30591adb05821bcd962535eb9a8f','{"title":"Synthetic general customer guidance","contentType":"text/plain","sourceKind":"synthetic_support_procedure"}'::jsonb)
  )
$$;

CREATE FUNCTION aegis_migrations.synthetic_chunk_is_approved(
  p_tenant uuid, p_source text, p_version integer, p_position integer, p_hash text)
RETURNS boolean LANGUAGE SQL IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
  SELECT (p_tenant,p_source,p_version,p_position,p_hash) IN (VALUES
    ('10000000-0000-4000-8000-000000000001'::uuid,'SYNTHETIC-NORTH-LOGIN-INCIDENT',1,0,'5d6bf61801302ce015412489a20a2e8d47275938f5faf2f0bb74cd5cc7e34d8f'),
    ('10000000-0000-4000-8000-000000000001'::uuid,'SYNTHETIC-NORTH-MFA-GUIDANCE',1,0,'e5ebccab6bc43873ec1541271bec892fb0b7df4940ebbd0b56a874a35a3d52f6'),
    ('10000000-0000-4000-8000-000000000001'::uuid,'SYNTHETIC-NORTH-ACCOUNT-RECOVERY',1,0,'d48aa435533b12493d20887c198ec65f404d8efff5cfc63c2f75dad32653872c'),
    ('10000000-0000-4000-8000-000000000001'::uuid,'SYNTHETIC-NORTH-NETWORK-DIAGNOSTICS',1,0,'689e0cf0a89aec39320510043eac25f9c1b7653014fa14271de166305aab3d33'),
    ('20000000-0000-4000-8000-000000000002'::uuid,'SYNTHETIC-SOUTH-BILLING-DISCREPANCY',1,0,'9e91cdcdc91d6363eb1187d3ea9358a5bc7ada9261b1eaf3c105699c06abe5a7'),
    ('20000000-0000-4000-8000-000000000002'::uuid,'SYNTHETIC-SOUTH-SERVICE-DEGRADATION',1,0,'7782b3892727def95c81f2e10c49f6b60ab05be2f500f5354dc8e2d594196b75'),
    ('20000000-0000-4000-8000-000000000002'::uuid,'SYNTHETIC-SOUTH-SUPPORT-ESCALATION',1,0,'9d61efa0c00a896a8d00197460b2e2f768c30876a59d58ef9440266eac8dade7'),
    ('20000000-0000-4000-8000-000000000002'::uuid,'SYNTHETIC-SOUTH-GENERAL-GUIDANCE',1,0,'78fab84d22b898436fb80780b095f4fd0faf30591adb05821bcd962535eb9a8f')
  )
$$;

REVOKE ALL ON FUNCTION aegis_migrations.synthetic_document_is_approved(uuid,text,integer,text,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION aegis_migrations.synthetic_chunk_is_approved(uuid,text,integer,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aegis_migrations.synthetic_document_is_approved(uuid,text,integer,text,text,jsonb) TO aegis_ingest;
GRANT EXECUTE ON FUNCTION aegis_migrations.synthetic_chunk_is_approved(uuid,text,integer,integer,text) TO aegis_ingest;

-- A fixed-catalog parent cannot commit until its exact approved chunk set is present.
-- This is SECURITY INVOKER: the ingestion role's SELECT is still constrained by forced RLS.
CREATE FUNCTION aegis_migrations.require_complete_synthetic_document() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE chunk_count bigint;
  approved_chunk_set boolean;
BEGIN
  IF NOT aegis_migrations.synthetic_document_is_approved(NEW.tenant_id, NEW.source_identity, NEW.version,
      NEW.ingestion_revision, NEW.content_sha256, NEW.metadata) THEN
    IF current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = 'aegis.documents'::regclass)
      OR EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = current_user AND (r.rolsuper OR r.rolbypassrls)) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Synthetic document manifest is invalid.';
  END IF;
  PERFORM set_config('aegis.access_mode', 'catalog_ingestion', true);
  PERFORM set_config('aegis.tenant_id', NEW.tenant_id::text, true);
  SELECT count(*), bool_and(c.position = 0 AND aegis_migrations.synthetic_chunk_is_approved(
      c.tenant_id, c.source_identity, c.document_version, c.position, c.content_sha256))
    INTO chunk_count, approved_chunk_set
    FROM aegis.document_chunks c
    WHERE c.tenant_id = NEW.tenant_id AND c.document_id = NEW.id
      AND c.document_version = NEW.version AND c.source_identity = NEW.source_identity;
  IF chunk_count <> 1 OR approved_chunk_set IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Synthetic document manifest is incomplete.';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION aegis_migrations.require_complete_synthetic_document() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aegis_migrations.require_complete_synthetic_document() TO aegis_ingest;

CREATE CONSTRAINT TRIGGER documents_require_complete_synthetic_chunks
AFTER INSERT ON aegis.documents DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION aegis_migrations.require_complete_synthetic_document();

CREATE POLICY document_catalog_ingest_read ON aegis.documents FOR SELECT TO aegis_ingest
  USING (current_setting('aegis.access_mode', true) = 'catalog_ingestion'
    AND tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid
    AND source_owner = 'Aegis synthetic corpus'
    AND ingestion_source = 'source-controlled-synthetic-catalog'
    AND aegis_migrations.synthetic_document_is_approved(tenant_id,source_identity,version,ingestion_revision,content_sha256,metadata));
CREATE POLICY document_catalog_ingest_insert ON aegis.documents FOR INSERT TO aegis_ingest
  WITH CHECK (current_setting('aegis.access_mode', true) = 'catalog_ingestion'
    AND tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid
    AND source_owner = 'Aegis synthetic corpus'
    AND ingestion_source = 'source-controlled-synthetic-catalog'
    AND aegis_migrations.synthetic_document_is_approved(tenant_id,source_identity,version,ingestion_revision,content_sha256,metadata));
CREATE POLICY document_chunk_catalog_ingest_read ON aegis.document_chunks FOR SELECT TO aegis_ingest
  USING (current_setting('aegis.access_mode', true) = 'catalog_ingestion'
    AND tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid
    AND aegis_migrations.synthetic_chunk_is_approved(tenant_id,source_identity,document_version,position,content_sha256));
CREATE POLICY document_chunk_catalog_ingest_insert ON aegis.document_chunks FOR INSERT TO aegis_ingest
  WITH CHECK (current_setting('aegis.access_mode', true) = 'catalog_ingestion'
    AND tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid
    AND aegis_migrations.synthetic_chunk_is_approved(tenant_id,source_identity,document_version,position,content_sha256));

REVOKE ALL ON TABLE aegis.documents, aegis.document_chunks FROM PUBLIC;
GRANT SELECT, INSERT ON aegis.documents, aegis.document_chunks TO aegis_ingest;
