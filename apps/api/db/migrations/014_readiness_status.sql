-- Readiness reads only the names of applied migrations, through a narrow function owned by the migration administrator. The runtime role
-- gets EXECUTE on this function and nothing else: no direct access to aegis_migrations.versions, and no checksums or timestamps.
CREATE OR REPLACE FUNCTION aegis_migrations.applied_versions()
  RETURNS SETOF text
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, aegis_migrations
AS $$ SELECT version FROM aegis_migrations.versions $$;
REVOKE ALL ON FUNCTION aegis_migrations.applied_versions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aegis_migrations.applied_versions() TO aegis_app;
