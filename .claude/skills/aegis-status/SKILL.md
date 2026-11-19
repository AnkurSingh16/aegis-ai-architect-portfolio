---
name: aegis-status
description: Show the current AEGIS milestone, completed work, remaining tasks, blockers, test evidence and recommended next action. Read-only.
disable-model-invocation: true
---

Summarise the project state for the owner. This is read-only.

1. Read `.claude/local/checkpoint.md`.
2. Run `git status --short` and `git log --oneline -1` to confirm the checkpoint is still accurate.
3. Print a table of frozen statuses from the checkpoint, unchanged.
4. Print, in under 250 words:
   - Current milestone.
   - Completed items, each marked reported or verified.
   - Remaining tasks in priority order.
   - Blockers, with the owner action each one needs.
   - Recommended next action, and whether it is authorised.

If the checkpoint and the Git state disagree, say so first. Do not reconcile them silently.
