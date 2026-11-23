-- P8: fix the orchestrator intake function (migration 018 is applied to existing databases, so the correction is a new migration).
-- Inside a SECURITY DEFINER function, current_user is the owner, so aegis.current_agent() (which reads current_user) is not the caller.
-- The caller is identified by session_user, which is the login role. Only the orchestrator role has EXECUTE on this function (018).
CREATE OR REPLACE FUNCTION aegis.orchestrator_intake(p_limit integer)
RETURNS TABLE (tenant_id uuid, execution_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, aegis AS $$
  SELECT e.tenant_id, e.execution_id FROM aegis.agent_executions e
   WHERE e.workflow_stage = 'submitted' AND e.status = 'pending'
     AND EXISTS (SELECT 1 FROM aegis.agent_database_roles m WHERE m.role_name = session_user AND m.agent_id = 'orchestrator')
   ORDER BY e.created_at, e.execution_id LIMIT GREATEST(1, LEAST(p_limit, 50))
$$;
REVOKE ALL ON FUNCTION aegis.orchestrator_intake(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aegis.orchestrator_intake(integer) TO aegis_orchestrator;
