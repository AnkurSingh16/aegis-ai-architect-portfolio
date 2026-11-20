-- Additive only: the caller's correlation id is recorded once, when the execution is created, so an operator can trace it.
ALTER TABLE aegis.workflow_executions
  ADD COLUMN correlation_id text CHECK (correlation_id IS NULL OR correlation_id ~ '^[A-Za-z0-9._:-]{1,128}$');

-- The application role may set the id at creation and may not change it afterwards.
GRANT INSERT (correlation_id) ON aegis.workflow_executions TO aegis_app;
