-- Additive only: an operator requeue of a dead-lettered execution records who asked and why, on the checkpoint it writes.
ALTER TABLE aegis.workflow_checkpoints
  ADD COLUMN actor text CHECK (actor IS NULL OR length(actor) BETWEEN 1 AND 256),
  ADD COLUMN reason text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 500);

-- Existing checkpoints keep NULL for both. The application role may write them and may not change them.
GRANT INSERT (actor, reason) ON aegis.workflow_checkpoints TO aegis_app;
