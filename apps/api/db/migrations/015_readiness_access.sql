-- Narrows the runtime role's access to the migration schema to what readiness needs: USAGE on the schema, so the function in
-- migration 014 can be called. Direct access to the version table is revoked. Earlier development runs granted SELECT on the table;
-- this removes that grant on existing databases. The runtime role keeps no CREATE or write privilege here.
REVOKE ALL ON aegis_migrations.versions FROM aegis_app;
GRANT USAGE ON SCHEMA aegis_migrations TO aegis_app;
