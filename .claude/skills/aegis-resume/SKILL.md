---
name: aegis-resume
description: Recover AEGIS work state at the start of a session - branch, protected changes, checkpoint, blockers and the next authorised action.
disable-model-invocation: true
---

Recover the working state. Do not change any file, index, stash or branch.

1. Read `.claude/local/checkpoint.md`. If it is missing, say so and stop after step 2.
2. Run `git status --short`, `git branch --show-current`, `git rev-parse HEAD` and `git log --oneline -5`.
3. Compare the result with the checkpoint. Report any differences: new or missing files, a different HEAD, or a different branch.
4. Confirm that the protected exploratory files are still present and uncommitted, if the checkpoint lists them.
5. Report, in under 200 words:
   - Branch, HEAD and approved base.
   - Protected files status.
   - Last verified checks, and when they were recorded. Mark each as reported or verified.
   - Current blockers and the owner approvals they need.
   - The next executable task that needs no new authorization.

Do not infer approvals. Use only the checkpoint's recorded statuses.
