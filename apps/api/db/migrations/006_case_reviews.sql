CREATE TABLE aegis.case_reviews (
  review_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  case_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approve', 'reject', 'defer')),
  actor_issuer text NOT NULL CHECK (length(actor_issuer) BETWEEN 1 AND 255),
  actor_subject text NOT NULL CHECK (length(actor_subject) BETWEEN 1 AND 255),
  note text CHECK (note IS NULL OR length(note) <= 1000),
  idempotency_key uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, case_id) REFERENCES aegis.support_cases (tenant_id, id),
  UNIQUE (tenant_id, case_id, idempotency_key)
);
CREATE INDEX case_reviews_tenant_case_history
  ON aegis.case_reviews (tenant_id, case_id, created_at, review_id);

ALTER TABLE aegis.case_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE aegis.case_reviews FORCE ROW LEVEL SECURITY;

CREATE POLICY case_review_read ON aegis.case_reviews FOR SELECT TO aegis_app
  USING (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid
    AND current_setting('aegis.access_mode', true) = 'authenticated'
    AND EXISTS (SELECT 1 FROM aegis.memberships m
      WHERE m.issuer = current_setting('aegis.principal_issuer', true)
        AND m.subject = current_setting('aegis.principal_subject', true)
        AND m.tenant_id = case_reviews.tenant_id));

CREATE POLICY case_review_operator_write ON aegis.case_reviews FOR INSERT TO aegis_app
  WITH CHECK (tenant_id = NULLIF(current_setting('aegis.tenant_id', true), '')::uuid
    AND current_setting('aegis.access_mode', true) = 'authenticated'
    AND actor_issuer = current_setting('aegis.principal_issuer', true)
    AND actor_subject = current_setting('aegis.principal_subject', true)
    AND EXISTS (SELECT 1 FROM aegis.memberships m
      WHERE m.issuer = current_setting('aegis.principal_issuer', true)
        AND m.subject = current_setting('aegis.principal_subject', true)
        AND m.tenant_id = case_reviews.tenant_id AND m.role = 'operator'));

CREATE FUNCTION aegis.attribute_case_review() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF session_user <> 'aegis_app' OR current_setting('aegis.access_mode', true) <> 'authenticated'
    OR NULLIF(current_setting('aegis.tenant_id', true), '') IS NULL
    OR NULLIF(current_setting('aegis.principal_issuer', true), '') IS NULL
    OR NULLIF(current_setting('aegis.principal_subject', true), '') IS NULL THEN
    RAISE EXCEPTION 'Authenticated review context required' USING ERRCODE = '42501';
  END IF;
  NEW.tenant_id := current_setting('aegis.tenant_id', true)::uuid;
  NEW.actor_issuer := current_setting('aegis.principal_issuer', true);
  NEW.actor_subject := current_setting('aegis.principal_subject', true);
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION aegis.attribute_case_review() FROM PUBLIC;
CREATE TRIGGER case_review_attribution BEFORE INSERT ON aegis.case_reviews
  FOR EACH ROW EXECUTE FUNCTION aegis.attribute_case_review();

REVOKE ALL ON TABLE aegis.case_reviews FROM PUBLIC, aegis_app;
GRANT SELECT ON aegis.case_reviews TO aegis_app;
GRANT INSERT (tenant_id, case_id, decision, note, idempotency_key) ON aegis.case_reviews TO aegis_app;
