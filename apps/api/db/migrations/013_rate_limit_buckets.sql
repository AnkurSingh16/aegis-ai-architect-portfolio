-- Additive only: shared token buckets, so a rate limit holds across API instances and workers. One row per tenant and
-- registered agent. Row level security scopes every row to its tenant, as for the other tenant tables.
CREATE TABLE aegis.rate_limit_buckets (
  tenant_id uuid NOT NULL REFERENCES aegis.tenants (id),
  bucket_key text NOT NULL CHECK (length(bucket_key) BETWEEN 1 AND 128),
  tokens double precision NOT NULL CHECK (tokens >= 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, bucket_key)
);

ALTER TABLE aegis.rate_limit_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE aegis.rate_limit_buckets FORCE ROW LEVEL SECURITY;
CREATE POLICY rate_limit_buckets_tenant ON aegis.rate_limit_buckets
  USING (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid);

-- The application role reads and writes buckets. It cannot delete them.
GRANT SELECT, INSERT (tenant_id, bucket_key, tokens, updated_at), UPDATE (tokens, updated_at) ON aegis.rate_limit_buckets TO aegis_app;
