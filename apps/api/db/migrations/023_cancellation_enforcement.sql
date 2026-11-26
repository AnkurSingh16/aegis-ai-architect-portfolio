-- P8 security hardening, remediation 4: cancellation enforced in the database. Additive. Migrations 001-022 are not changed.
--
-- Linearisation point (documented semantics):
-- - A cancellation takes effect when the UPDATE that sets aegis.agent_executions.cancel_requested commits. The orchestrator's stage
--   transition and the cancellation UPDATE both write the same execution row, so PostgreSQL serialises them on that row lock; whichever
--   commits first wins, and the other re-evaluates against the committed row (READ COMMITTED re-check on the locked row).
-- - A finalisation (stage 'completed') that commits before the cancellation is a completed execution. The cancellation is then recorded
--   as a request on a terminal execution and is refused by the application, as before.
-- - A request-grant consumption is refused once cancel_requested is committed. The consumption check reads the committed value in the
--   consuming statement. A consumption that commits before the cancellation commits is a consumption before cancellation; the window
--   is one statement and is bounded. It cannot lead to a finalised answer, because of the next rule.
--
-- Rules added:
-- 1. A cancelled execution cannot enter stage 'completed'. The stage trigger (018) refuses that transition when cancel_requested is true.
-- 2. A request grant cannot move from open to consumed when its execution has cancel_requested = true. Result grants are unaffected, so
--    results already in flight are still processed and discarded by the orchestrator, as before.
-- 3. Existing rules are unchanged: terminal executions are refused by the application's receive path; fencing tokens, transactional
--    writes and the stage-transition table are not weakened.

CREATE OR REPLACE FUNCTION aegis.enforce_stage_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, aegis AS $$
BEGIN
  IF NEW.workflow_stage IS DISTINCT FROM OLD.workflow_stage
     AND NOT aegis.stage_transition_allowed(OLD.workflow_stage, NEW.workflow_stage) THEN
    RAISE EXCEPTION 'workflow stage transition is not permitted' USING ERRCODE = '42501';
  END IF;
  IF NEW.workflow_stage = 'completed' AND OLD.workflow_stage IS DISTINCT FROM 'completed' AND NEW.cancel_requested THEN
    RAISE EXCEPTION 'a cancelled investigation cannot complete' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

-- Narrow read of one boolean, run by the owner so that a participant's row visibility cannot hide the flag. It returns only
-- cancel_requested for one (tenant, execution) pair. The owner must be able to read the table (superuser or BYPASSRLS), as the
-- other owner-run functions in this schema already require; see docs/SECURITY-TENANT-BOUNDARIES.md section 5.
CREATE FUNCTION aegis.execution_cancel_requested(p_tenant uuid, p_execution uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, aegis AS $$
  SELECT e.cancel_requested FROM aegis.agent_executions e WHERE e.tenant_id = p_tenant AND e.execution_id = p_execution
$$;
REVOKE ALL ON FUNCTION aegis.execution_cancel_requested(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aegis.execution_cancel_requested(uuid, uuid) TO aegis_orchestrator, aegis_triage, aegis_retrieval, aegis_reviewer;

CREATE FUNCTION aegis.refuse_request_consumption_after_cancel() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, aegis AS $$
DECLARE
  requested boolean;
BEGIN
  IF NEW.kind = 'request' AND OLD.status = 'open' AND NEW.status = 'consumed' THEN
    requested := aegis.execution_cancel_requested(NEW.tenant_id, NEW.execution_id);
    -- A missing or unreadable execution is refused as well: consumption requires a visible, uncancelled execution.
    IF requested IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'request grant cannot be consumed after cancellation' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION aegis.refuse_request_consumption_after_cancel() FROM PUBLIC;

CREATE TRIGGER agent_grant_refuse_consume_after_cancel BEFORE UPDATE OF status ON aegis.agent_grants
  FOR EACH ROW EXECUTE FUNCTION aegis.refuse_request_consumption_after_cancel();
