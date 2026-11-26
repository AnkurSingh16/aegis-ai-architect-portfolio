-- P8 security hardening, cancellation authority: the orchestrator owns cancellation. Additive. Migrations 001-023 are not changed.
--
-- 1. No participant-executable privileged function. Migration 023 granted EXECUTE on aegis.execution_cancel_requested to the participant
--    roles so the consumption refusal could read the flag. The trigger now reads the flag itself, inside a SECURITY DEFINER trigger
--    function owned by the schema owner, and the participant-callable helper is removed. The owner must be able to read the execution
--    table (superuser or BYPASSRLS), as the other owner-run functions in this schema already require (docs/SECURITY-TENANT-BOUNDARIES.md).
-- 2. Cancellation discovery is orchestrator-only. aegis.orchestrator_pending_cancellations returns only (tenant_id, execution_id) for
--    nonterminal executions with cancel_requested = true. It takes no tenant or principal argument, its caller is checked against the
--    database role membership table (as aegis.orchestrator_intake in 019 does), and it is executable only by aegis_orchestrator.
--    It is not a general tenant enumeration API: it returns nothing for any other role.

-- 1. The consumption refusal, owner-run. A request grant cannot move from open to consumed unless its execution is visible to the owner
--    and not cancel_requested. A missing execution is refused as well.
CREATE OR REPLACE FUNCTION aegis.refuse_request_consumption_after_cancel() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, aegis AS $$
BEGIN
  IF NEW.kind = 'request' AND OLD.status = 'open' AND NEW.status = 'consumed' THEN
    IF NOT EXISTS (SELECT 1 FROM aegis.agent_executions e
                    WHERE e.tenant_id = NEW.tenant_id AND e.execution_id = NEW.execution_id AND NOT e.cancel_requested) THEN
      RAISE EXCEPTION 'request grant cannot be consumed after cancellation' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP FUNCTION aegis.execution_cancel_requested(uuid, uuid);

-- 2. Orchestrator-only discovery of executions whose cancellation is requested but not yet finalised. Bounded by the caller's limit.
CREATE FUNCTION aegis.orchestrator_pending_cancellations(p_limit integer)
RETURNS TABLE (tenant_id uuid, execution_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, aegis AS $$
  SELECT e.tenant_id, e.execution_id FROM aegis.agent_executions e
   WHERE e.cancel_requested AND e.status NOT IN ('succeeded', 'failed', 'cancelled')
     AND EXISTS (SELECT 1 FROM aegis.agent_database_roles m WHERE m.role_name = session_user AND m.agent_id = 'orchestrator')
   ORDER BY e.updated_at, e.execution_id LIMIT GREATEST(1, LEAST(p_limit, 50))
$$;
REVOKE ALL ON FUNCTION aegis.orchestrator_pending_cancellations(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aegis.orchestrator_pending_cancellations(integer) TO aegis_orchestrator;
