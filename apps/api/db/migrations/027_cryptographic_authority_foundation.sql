-- P8 Phase B1.3: PostgreSQL cryptographic authority foundation. Additive. Migrations 001-026 are not changed.
--
-- This migration establishes the verifier only. It does NOT change any existing RLS policy and does NOT make any application path depend on
-- the verifier yet. F3 remains open until the policy cutover (a later migration) and the application and gateway integration have passed
-- their acceptance tests.
--
-- Trust model (T1, the approved threat model): an attacker with arbitrary SQL under a runtime login. The HMAC key is held by trusted
-- application code (the signer) and is stored here for verification. No runtime login can read it, change it, sign with it, or run code as
-- the verifier owner. T2 (compromise of the whole application process, including its signing material) is OUT of scope and not accepted.
--
-- Objects:
--   aegis_authority_owner  NOLOGIN role that owns the verifier, its key store and its configuration. It holds no login and no membership.
--   aegis_authority        schema: keys (HMAC key material), config (trusted audience and clock allowance), decode_fields, verify_assertion.
--   aegis_crypto           schema: the pgcrypto extension (HMAC-SHA-256 is aegis_crypto.hmac).
-- Verifier is SECURITY DEFINER, owned by aegis_authority_owner, with a pinned search_path and fully schema-qualified references.

-- 1. Verifier owner (NOLOGIN). Same attributes as the other workload roles: no login, no inheritance, no role or database creation.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aegis_authority_owner') THEN
    CREATE ROLE aegis_authority_owner NOLOGIN NOINHERIT NOCREATEROLE NOCREATEDB NOBYPASSRLS NOREPLICATION;
  END IF;
END $$;

-- 2. Cryptographic extension in its own schema. The schema is owned by the verifier owner so that no other role can add objects to it.
CREATE SCHEMA IF NOT EXISTS aegis_crypto AUTHORIZATION aegis_authority_owner;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA aegis_crypto;
REVOKE ALL ON SCHEMA aegis_crypto FROM PUBLIC;
GRANT USAGE ON SCHEMA aegis_crypto TO aegis_authority_owner;

-- 3. Verifier schema and protected storage. Owned by the verifier owner. No grants to any runtime role on the tables.
CREATE SCHEMA IF NOT EXISTS aegis_authority AUTHORIZATION aegis_authority_owner;
REVOKE ALL ON SCHEMA aegis_authority FROM PUBLIC;

CREATE TABLE aegis_authority.keys (
  key_id text PRIMARY KEY CHECK (key_id ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
  -- HMAC-SHA-256 key material. The minimum (32 bytes) and maximum are enforced here and in the signer.
  key_material bytea NOT NULL CHECK (octet_length(key_material) BETWEEN 32 AND 128),
  -- NULL means no scheduled expiry. A key past not_after is refused exactly like a missing key (fail closed).
  not_after timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Trusted configuration: the database audience (a deployment identity, not a caller parameter) and the permitted clock allowance. There is
-- deliberately no default row: an unprovisioned database refuses every assertion.
CREATE TABLE aegis_authority.config (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  audience text NOT NULL CHECK (octet_length(audience) BETWEEN 1 AND 255 AND audience ~ '^[A-Za-z0-9._:/-]+$'),
  max_clock_skew_seconds integer NOT NULL DEFAULT 5 CHECK (max_clock_skew_seconds BETWEEN 0 AND 30)
);

ALTER TABLE aegis_authority.keys OWNER TO aegis_authority_owner;
ALTER TABLE aegis_authority.config OWNER TO aegis_authority_owner;
REVOKE ALL ON TABLE aegis_authority.keys FROM PUBLIC;
REVOKE ALL ON TABLE aegis_authority.config FROM PUBLIC;

-- 4. Canonical field decoder. Pure: it reads bytes and returns text fields. It does not authorise anything and is not granted to runtime roles.
--    It refuses leading zeros, empty and oversized fields, invalid UTF-8 (convert_from is strict), and any payload that does not re-encode to
--    exactly the same bytes. All refusals use one generic message that names no key, field or internal detail.
CREATE FUNCTION aegis_authority.decode_fields(p_payload bytea)
RETURNS text[]
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  n integer := octet_length(p_payload);
  pos integer := 0;
  colon integer;
  flen integer;
  digits integer;
  b integer;
  i integer;
  fields text[] := ARRAY[]::text[];
  value text;
  rebuilt bytea := ''::bytea;
BEGIN
  IF p_payload IS NULL OR n < 1 OR n > 2048 THEN
    RAISE EXCEPTION 'authority assertion refused' USING ERRCODE = '42501';
  END IF;
  WHILE pos < n LOOP
    colon := -1;
    FOR i IN pos .. n - 1 LOOP
      IF get_byte(p_payload, i) = 58 THEN colon := i; EXIT; END IF;
    END LOOP;
    IF colon = -1 OR colon = pos THEN
      RAISE EXCEPTION 'authority assertion refused' USING ERRCODE = '42501';
    END IF;
    digits := colon - pos;
    IF digits > 3 OR (digits > 1 AND get_byte(p_payload, pos) = 48) THEN
      RAISE EXCEPTION 'authority assertion refused' USING ERRCODE = '42501';
    END IF;
    flen := 0;
    FOR i IN pos .. colon - 1 LOOP
      b := get_byte(p_payload, i);
      IF b < 48 OR b > 57 THEN RAISE EXCEPTION 'authority assertion refused' USING ERRCODE = '42501'; END IF;
      flen := flen * 10 + (b - 48);
    END LOOP;
    IF flen < 1 OR flen > 255 OR colon + 1 + flen > n THEN
      RAISE EXCEPTION 'authority assertion refused' USING ERRCODE = '42501';
    END IF;
    BEGIN
      value := convert_from(substring(p_payload FROM colon + 2 FOR flen), 'UTF8');
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'authority assertion refused' USING ERRCODE = '42501';
    END;
    fields := fields || value;
    pos := colon + 1 + flen;
  END LOOP;
  -- Canonical re-encoding: the authenticated bytes must be exactly the encoding of the decoded fields.
  FOR i IN 1 .. COALESCE(array_length(fields, 1), 0) LOOP
    rebuilt := rebuilt || convert_to(octet_length(convert_to(fields[i], 'UTF8'))::text || ':', 'UTF8') || convert_to(fields[i], 'UTF8');
  END LOOP;
  IF rebuilt IS DISTINCT FROM p_payload THEN
    RAISE EXCEPTION 'authority assertion refused' USING ERRCODE = '42501';
  END IF;
  RETURN fields;
END;
$$;

-- 5. The verifier. It validates every binding independently in the database. The MAC is checked before any field is trusted.
--    Bindings are PostgreSQL's own: session_user (the login), pg_current_xact_id() (the top-level transaction), pg_backend_pid() (the
--    connection) and clock_timestamp() (database time, not transaction start). The audience comes from trusted configuration.
--    The return value is the verified claims only. It is never a signature and never exposes key material.
CREATE FUNCTION aegis_authority.verify_assertion(p_token text)
RETURNS TABLE (issuer text, subject text, tenant_id text, scope_ceiling text, purpose text, assertion_id text, expires_at bigint)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  parts text[];
  payload bytea;
  f text[];
  k record;
  cfg record;
  now_s bigint := floor(extract(epoch FROM clock_timestamp()))::bigint;
  issued bigint;
  expires bigint;
  bound_txid text := pg_current_xact_id()::text;
  bound_pid integer := pg_backend_pid();
  fail constant text := 'authority assertion refused';
BEGIN
  -- Bounded, syntactic checks first. Nothing here is trusted yet.
  IF p_token IS NULL OR octet_length(p_token) > 4096 THEN RAISE EXCEPTION '%', fail USING ERRCODE = '42501'; END IF;
  parts := string_to_array(p_token, '.');
  IF array_length(parts, 1) IS DISTINCT FROM 3 OR parts[1] IS DISTINCT FROM 'aegis-auth-v1' THEN
    RAISE EXCEPTION '%', fail USING ERRCODE = '42501';
  END IF;
  IF parts[2] !~ '^([0-9a-f][0-9a-f])+$' OR octet_length(parts[2]) > 4096 OR parts[3] !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION '%', fail USING ERRCODE = '42501';
  END IF;
  payload := decode(parts[2], 'hex');
  f := aegis_authority.decode_fields(payload);
  IF array_length(f, 1) IS DISTINCT FROM 14 OR f[1] IS DISTINCT FROM 'aegis-auth-v1' THEN
    RAISE EXCEPTION '%', fail USING ERRCODE = '42501';
  END IF;

  -- The key and the audience are trusted configuration. A missing key or missing configuration fails closed.
  SELECT key_material INTO k FROM aegis_authority.keys
   WHERE key_id = f[2] AND (not_after IS NULL OR not_after > clock_timestamp());
  IF NOT FOUND THEN RAISE EXCEPTION '%', fail USING ERRCODE = '42501'; END IF;
  SELECT audience, max_clock_skew_seconds INTO cfg FROM aegis_authority.config;
  IF NOT FOUND THEN RAISE EXCEPTION '%', fail USING ERRCODE = '42501'; END IF;

  -- Authenticity: HMAC-SHA-256 over the exact payload bytes. The comparison is bytea equality; see the document for its limits.
  IF aegis_crypto.hmac(payload, k.key_material, 'sha256') IS DISTINCT FROM decode(parts[3], 'hex') THEN
    RAISE EXCEPTION '%', fail USING ERRCODE = '42501';
  END IF;

  -- Field validation (the MAC has authenticated these bytes).
  IF f[3] ~ '[\x01-\x1f\x7f]' OR f[4] ~ '[\x01-\x1f\x7f]' OR octet_length(f[3]) > 255 OR octet_length(f[4]) > 255 THEN
    RAISE EXCEPTION '%', fail USING ERRCODE = '42501';
  END IF;
  IF f[5] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION '%', fail USING ERRCODE = '42501'; END IF;
  IF f[6] NOT IN ('read:cases', 'write:cases', 'read:cases,write:cases') THEN RAISE EXCEPTION '%', fail USING ERRCODE = '42501'; END IF;
  IF f[7] NOT IN ('case_read', 'case_write', 'investigation_create', 'investigation_read', 'investigation_cancel', 'workflow_bookkeeping') THEN
    RAISE EXCEPTION '%', fail USING ERRCODE = '42501';
  END IF;
  IF f[8] IS DISTINCT FROM cfg.audience THEN RAISE EXCEPTION '%', fail USING ERRCODE = '42501'; END IF;
  IF f[9] IS DISTINCT FROM session_user::text THEN RAISE EXCEPTION '%', fail USING ERRCODE = '42501'; END IF;
  IF f[10] IS DISTINCT FROM bound_txid THEN RAISE EXCEPTION '%', fail USING ERRCODE = '42501'; END IF;
  IF f[11] !~ '^[1-9][0-9]{0,9}$' OR f[11]::bigint IS DISTINCT FROM bound_pid::bigint THEN RAISE EXCEPTION '%', fail USING ERRCODE = '42501'; END IF;
  IF f[12] !~ '^(0|[1-9][0-9]{0,15})$' OR f[13] !~ '^(0|[1-9][0-9]{0,15})$' THEN RAISE EXCEPTION '%', fail USING ERRCODE = '42501'; END IF;
  issued := f[12]::bigint;
  expires := f[13]::bigint;
  IF issued > 253402300799 OR expires > 253402300799 THEN RAISE EXCEPTION '%', fail USING ERRCODE = '42501'; END IF;
  IF expires <= issued OR expires - issued > 300 THEN RAISE EXCEPTION '%', fail USING ERRCODE = '42501'; END IF;
  -- Database time. Not issued in the future beyond the allowance, and not expired.
  IF issued > now_s + cfg.max_clock_skew_seconds OR expires <= now_s THEN RAISE EXCEPTION '%', fail USING ERRCODE = '42501'; END IF;
  IF f[14] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION '%', fail USING ERRCODE = '42501'; END IF;
  -- The login is bound as well: session_user above is the caller's login (the SECURITY DEFINER owner never appears here).

  RETURN QUERY SELECT f[3], f[4], f[5], f[6], f[7], f[14], expires;
END;
$$;

-- 6. Ownership and privileges. Runtime roles get EXECUTE on the verifier and nothing else. No runtime role can read the key or the config.
ALTER FUNCTION aegis_authority.decode_fields(bytea) OWNER TO aegis_authority_owner;
ALTER FUNCTION aegis_authority.verify_assertion(text) OWNER TO aegis_authority_owner;
REVOKE ALL ON FUNCTION aegis_authority.decode_fields(bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION aegis_authority.verify_assertion(text) FROM PUBLIC;
GRANT USAGE ON SCHEMA aegis_authority TO aegis_app;
GRANT EXECUTE ON FUNCTION aegis_authority.verify_assertion(text) TO aegis_app;
