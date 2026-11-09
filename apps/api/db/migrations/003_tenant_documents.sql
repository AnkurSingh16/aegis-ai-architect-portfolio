CREATE TABLE aegis.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES aegis.tenants(id),
  source_identity text NOT NULL CHECK (length(source_identity) BETWEEN 1 AND 160
    AND source_identity ~ '^SYNTHETIC-[A-Z0-9][A-Z0-9._-]*$'),
  version integer NOT NULL CHECK (version BETWEEN 1 AND 2147483647),
  source_owner text NOT NULL CHECK (length(source_owner) BETWEEN 1 AND 120),
  ingestion_source text NOT NULL CHECK (ingestion_source = 'source-controlled-synthetic-catalog'),
  ingestion_revision text NOT NULL CHECK (length(ingestion_revision) BETWEEN 1 AND 64),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'
    AND octet_length(metadata::text) <= 4096),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, source_identity, version),
  UNIQUE (tenant_id, id, version),
  UNIQUE (tenant_id, id, version, source_identity)
);

CREATE TABLE aegis.document_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES aegis.tenants(id),
  document_id uuid NOT NULL,
  document_version integer NOT NULL CHECK (document_version BETWEEN 1 AND 2147483647),
  source_identity text NOT NULL CHECK (length(source_identity) BETWEEN 1 AND 160
    AND source_identity ~ '^SYNTHETIC-[A-Z0-9][A-Z0-9._-]*$'),
  position integer NOT NULL CHECK (position BETWEEN 0 AND 255),
  content text NOT NULL CHECK (octet_length(content) BETWEEN 1 AND 8192),
  content_sha256 text NOT NULL CHECK (content_sha256 = encode(sha256(convert_to(content, 'UTF8')), 'hex')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, document_id, document_version, source_identity)
    REFERENCES aegis.documents (tenant_id, id, version, source_identity),
  UNIQUE (tenant_id, document_id, document_version, position)
);

ALTER TABLE aegis.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE aegis.documents FORCE ROW LEVEL SECURITY;
ALTER TABLE aegis.document_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE aegis.document_chunks FORCE ROW LEVEL SECURITY;

CREATE POLICY document_membership_read ON aegis.documents FOR SELECT TO aegis_app
  USING (current_setting('aegis.access_mode', true) = 'authenticated'
    AND tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM aegis.memberships m
      WHERE m.issuer = current_setting('aegis.principal_issuer', true)
        AND m.subject = current_setting('aegis.principal_subject', true)
        AND m.tenant_id = documents.tenant_id));

CREATE POLICY document_chunk_membership_read ON aegis.document_chunks FOR SELECT TO aegis_app
  USING (current_setting('aegis.access_mode', true) = 'authenticated'
    AND tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM aegis.memberships m
      WHERE m.issuer = current_setting('aegis.principal_issuer', true)
        AND m.subject = current_setting('aegis.principal_subject', true)
        AND m.tenant_id = document_chunks.tenant_id));

REVOKE ALL ON TABLE aegis.documents, aegis.document_chunks FROM PUBLIC, aegis_app;
GRANT SELECT ON aegis.documents, aegis.document_chunks TO aegis_app;
