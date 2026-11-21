# One-shot job that creates Keycloak's role and database. Uses the pinned PostgreSQL 17 + pgvector client tools (arm64 verified).
FROM pgvector/pgvector@sha256:ac08538c6f8b9904c33c8224c5e5706dbe760aca29db1d096972b4052c22a75d
COPY init-keycloak-db.sql /init/init-keycloak-db.sql
