-- Additive only: derived embeddings for existing document chunks. Does not alter existing tables.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE aegis.chunk_embeddings (
  chunk_id uuid NOT NULL REFERENCES aegis.document_chunks (id),
  tenant_id uuid NOT NULL REFERENCES aegis.tenants (id),
  model text NOT NULL CHECK (model IN ('nomic-embed-text')),
  model_digest text NOT NULL CHECK (model_digest ~ '^[0-9a-f]{64}$'),
  embedding vector(768) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (chunk_id, model)
);
CREATE INDEX chunk_embeddings_cosine ON aegis.chunk_embeddings USING hnsw (embedding vector_cosine_ops);

ALTER TABLE aegis.chunk_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE aegis.chunk_embeddings FORCE ROW LEVEL SECURITY;

CREATE POLICY chunk_embedding_tenant_read ON aegis.chunk_embeddings FOR SELECT TO aegis_app
  USING (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid);

-- A tenant may only embed chunks that belong to that same tenant.
CREATE POLICY chunk_embedding_tenant_insert ON aegis.chunk_embeddings FOR INSERT TO aegis_app
  WITH CHECK (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM aegis.document_chunks c WHERE c.id = chunk_embeddings.chunk_id AND c.tenant_id = chunk_embeddings.tenant_id));

REVOKE ALL ON TABLE aegis.chunk_embeddings FROM PUBLIC, aegis_app;
GRANT SELECT ON aegis.chunk_embeddings TO aegis_app;
GRANT INSERT (chunk_id, tenant_id, model, model_digest, embedding) ON aegis.chunk_embeddings TO aegis_app;
