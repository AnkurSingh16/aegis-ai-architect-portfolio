-- Additive only: a cancellation request records who asked and why on the execution, so the cancel is auditable from the
-- moment it is requested, not only when the driver finishes it. The cancelled checkpoint copies both values.
ALTER TABLE aegis.workflow_executions
  ADD COLUMN cancel_requested_by text CHECK (cancel_requested_by IS NULL OR length(cancel_requested_by) BETWEEN 1 AND 256),
  ADD COLUMN cancel_reason text CHECK (cancel_reason IS NULL OR length(cancel_reason) BETWEEN 1 AND 500);

-- The application role may set the two values when a cancellation is requested. The store sets them only once (COALESCE),
-- so a later request does not replace the first actor and reason.
GRANT UPDATE (cancel_requested_by, cancel_reason) ON aegis.workflow_executions TO aegis_app;
