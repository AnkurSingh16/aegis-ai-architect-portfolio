-- P8 security hardening, Phase A: durable, fair and bounded cancellation reconciliation. Additive. Migrations 001-024 are not changed.
--
-- Design decision: the retry state lives on aegis.agent_executions, not in a separate table. A cancellation is one-to-one with its
-- execution, the composite key (tenant_id, execution_id) already exists, and no new row-level policy or join is needed. Every new column
-- is fixed-size and sanitised: there is no free-text failure message. The orchestrator can change only these columns; participants and
-- the gateway get no new privilege.
--
-- State model (per execution with cancel_requested = true and a non-terminal status):
--   next_attempt_at <= now  -> eligible for discovery (ordered by next_attempt_at, then execution_id)
--   a successful finalisation -> terminal; retry metadata is cleared
--   a failed attempt        -> attempts + 1, last_attempt_at = now, failure_class set, next_attempt_at = now + backoff
-- Backoff (database time): 1 s doubling per attempt, capped at 60 s. Attempts saturate at 1000; the counter cannot overflow.
-- A failed execution is never abandoned: it stays visible in aegis.orchestrator_cancellation_backlog() and is retried at the cap.

-- 1. Columns and bounds ---------------------------------------------------------------------------------------------------------------
ALTER TABLE aegis.agent_executions
  ADD COLUMN cancel_requested_at timestamptz,
  ADD COLUMN cancellation_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN cancellation_next_attempt_at timestamptz,
  ADD COLUMN cancellation_last_attempt_at timestamptz,
  ADD COLUMN cancellation_failure_class text;

-- Upgrade compatibility: every execution already requesting cancellation gets a request time and an immediate eligibility time.
-- Terminal executions need no scheduling; they are excluded from discovery by status.
UPDATE aegis.agent_executions
   SET cancel_requested_at = updated_at,
       cancellation_next_attempt_at = clock_timestamp()
 WHERE cancel_requested AND status NOT IN ('succeeded', 'failed', 'cancelled');
UPDATE aegis.agent_executions SET cancel_requested_at = updated_at WHERE cancel_requested AND cancel_requested_at IS NULL;

ALTER TABLE aegis.agent_executions
  ADD CONSTRAINT agent_executions_cancellation_attempts_bounded CHECK (cancellation_attempts BETWEEN 0 AND 1000),
  ADD CONSTRAINT agent_executions_cancellation_failure_class CHECK (cancellation_failure_class IS NULL
    OR cancellation_failure_class IN ('transient', 'systemic', 'execution_refused')),
  ADD CONSTRAINT agent_executions_cancel_requested_recorded CHECK (NOT cancel_requested OR cancel_requested_at IS NOT NULL),
  ADD CONSTRAINT agent_executions_cancel_schedule_present CHECK (NOT cancel_requested OR status IN ('succeeded', 'failed', 'cancelled')
    OR cancellation_next_attempt_at IS NOT NULL),
  ADD CONSTRAINT agent_executions_cancel_retry_state_consistent CHECK (cancellation_attempts = 0
    OR (cancellation_last_attempt_at IS NOT NULL AND cancellation_failure_class IS NOT NULL));

-- Partial index for the discovery query: only nonterminal cancellations are indexed, so the index stays small.
CREATE INDEX agent_executions_pending_cancellation ON aegis.agent_executions (cancellation_next_attempt_at, tenant_id, execution_id)
  WHERE cancel_requested AND status NOT IN ('succeeded', 'failed', 'cancelled');

-- 2. Database time for the request, set by the database when cancel_requested first becomes true. The gateway needs no new privilege.
CREATE FUNCTION aegis.record_cancellation_request() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, aegis AS $$
BEGIN
  NEW.cancel_requested_at := clock_timestamp();
  NEW.cancellation_next_attempt_at := clock_timestamp();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION aegis.record_cancellation_request() FROM PUBLIC;

CREATE TRIGGER agent_execution_record_cancellation_request BEFORE UPDATE OF cancel_requested ON aegis.agent_executions
  FOR EACH ROW WHEN (NEW.cancel_requested AND NOT OLD.cancel_requested)
  EXECUTE FUNCTION aegis.record_cancellation_request();

-- 3. Request-grant consumption, serialised against cancellation. Migration 024 read cancel_requested without a lock. Under READ COMMITTED
-- that is a window: a consumption that reads 'not cancelled' can commit while a cancellation commits. FOR SHARE on the execution row
-- conflicts with the FOR NO KEY UPDATE taken by every cancellation write, so the two transactions are ordered by PostgreSQL. The
-- consumption holds the share lock until it commits; a cancellation that commits first is seen as cancel_requested = true here.
CREATE OR REPLACE FUNCTION aegis.refuse_request_consumption_after_cancel() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, aegis AS $$
DECLARE
  requested boolean;
BEGIN
  IF NEW.kind = 'request' AND OLD.status = 'open' AND NEW.status = 'consumed' THEN
    SELECT e.cancel_requested INTO requested FROM aegis.agent_executions e
     WHERE e.tenant_id = NEW.tenant_id AND e.execution_id = NEW.execution_id FOR SHARE;
    -- A missing or unreadable execution is refused as well: consumption requires a visible, uncancelled execution.
    IF requested IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'request grant cannot be consumed after cancellation' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- 4. Fair, bounded, orchestrator-only discovery. Replaces the 024 function, which ordered by updated_at and so let a failing execution keep
-- its place in front of later candidates. Ineligible rows (next attempt in the future) are not returned at all.
DROP FUNCTION aegis.orchestrator_pending_cancellations(integer);

CREATE FUNCTION aegis.orchestrator_due_cancellations(p_limit integer)
RETURNS TABLE (tenant_id uuid, execution_id uuid, cancellation_attempts integer)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, aegis AS $$
  SELECT e.tenant_id, e.execution_id, e.cancellation_attempts
    FROM aegis.agent_executions e
   WHERE e.cancel_requested AND e.status NOT IN ('succeeded', 'failed', 'cancelled')
     AND e.cancellation_next_attempt_at <= clock_timestamp()
     AND EXISTS (SELECT 1 FROM aegis.agent_database_roles m WHERE m.role_name = session_user AND m.agent_id = 'orchestrator')
   ORDER BY e.cancellation_next_attempt_at, e.execution_id
   LIMIT GREATEST(1, LEAST(p_limit, 50))
$$;
REVOKE ALL ON FUNCTION aegis.orchestrator_due_cancellations(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aegis.orchestrator_due_cancellations(integer) TO aegis_orchestrator;

-- 5. Aggregate visibility for operators: counts and ages only, across tenants, with no identifiers. Orchestrator-only.
CREATE FUNCTION aegis.orchestrator_cancellation_backlog()
RETURNS TABLE (pending bigint, overdue bigint, failing bigint, max_attempts integer, oldest_request_age_seconds double precision)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, aegis AS $$
  SELECT count(*),
         count(*) FILTER (WHERE e.cancellation_next_attempt_at <= clock_timestamp()),
         count(*) FILTER (WHERE e.cancellation_attempts > 0),
         COALESCE(max(e.cancellation_attempts), 0),
         COALESCE(EXTRACT(EPOCH FROM (clock_timestamp() - min(e.cancel_requested_at)))::double precision, 0)
    FROM aegis.agent_executions e
   WHERE e.cancel_requested AND e.status NOT IN ('succeeded', 'failed', 'cancelled')
     AND EXISTS (SELECT 1 FROM aegis.agent_database_roles m WHERE m.role_name = session_user AND m.agent_id = 'orchestrator')
$$;
REVOKE ALL ON FUNCTION aegis.orchestrator_cancellation_backlog() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aegis.orchestrator_cancellation_backlog() TO aegis_orchestrator;

-- 6. Privileges. The orchestrator may write only the retry columns; participants, triage, retrieval, reviewer and the gateway get nothing.
GRANT UPDATE (cancellation_attempts, cancellation_last_attempt_at, cancellation_next_attempt_at, cancellation_failure_class)
  ON aegis.agent_executions TO aegis_orchestrator;
