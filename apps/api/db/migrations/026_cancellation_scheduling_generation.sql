-- P8 security hardening, Phase A.2: a scheduling generation separate from the capped attempt count. Additive. Migrations 001-025 are not
-- changed.
--
-- Decision: migration 025 is NOT amended. It was pushed only to the unmerged draft, but no persistent database can be shown to have
-- applied only one of its revisions, so a new migration is the safe path. This migration applies after 025 on every database.
--
-- Why: cancellation_attempts saturates at 1000 (its CHECK bound). The failure guard in 025 compared the scheduling generation with that
-- saturating count, so at saturation several stale writers that had each read 1000 could all match, and each could advance a schedule
-- that a newer writer had already moved. cancellation_generation is never capped. Every schedule write increments it, and a failure is
-- recorded only while the generation the orchestrator read at discovery is still current. The attempt count keeps its meaning:
-- operational history, saturating, used only to compute the backoff (capped at 60 seconds).
--
-- Permissions: the orchestrator may write the generation and nothing else new. Participants, the gateway, triage, retrieval and reviewer
-- get no new privilege.

-- 1. The generation. Starts at 0 for every execution, including upgraded rows. Non-negative by constraint; bigint has no practical bound.
ALTER TABLE aegis.agent_executions
  ADD COLUMN cancellation_generation bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT agent_executions_cancellation_generation_nonnegative CHECK (cancellation_generation >= 0);

-- 2. Discovery returns the generation alongside the attempt count. The signature (one integer argument) is unchanged, so the startup
-- authority check still identifies the function exactly. Only the return columns change, which requires dropping and recreating it.
DROP FUNCTION aegis.orchestrator_due_cancellations(integer);

CREATE FUNCTION aegis.orchestrator_due_cancellations(p_limit integer)
RETURNS TABLE (tenant_id uuid, execution_id uuid, cancellation_attempts integer, cancellation_generation bigint)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, aegis AS $$
  SELECT e.tenant_id, e.execution_id, e.cancellation_attempts, e.cancellation_generation
    FROM aegis.agent_executions e
   WHERE e.cancel_requested AND e.status NOT IN ('succeeded', 'failed', 'cancelled')
     AND e.cancellation_next_attempt_at <= clock_timestamp()
     AND EXISTS (SELECT 1 FROM aegis.agent_database_roles m WHERE m.role_name = session_user AND m.agent_id = 'orchestrator')
   ORDER BY e.cancellation_next_attempt_at, e.execution_id
   LIMIT GREATEST(1, LEAST(p_limit, 50))
   FOR UPDATE SKIP LOCKED
$$;
REVOKE ALL ON FUNCTION aegis.orchestrator_due_cancellations(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aegis.orchestrator_due_cancellations(integer) TO aegis_orchestrator;

-- 3. The orchestrator writes the generation in the same statement as the schedule (see the store's recordCancellationFailure).
GRANT UPDATE (cancellation_generation) ON aegis.agent_executions TO aegis_orchestrator;
