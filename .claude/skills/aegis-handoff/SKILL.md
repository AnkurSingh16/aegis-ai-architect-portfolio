---
name: aegis-handoff
description: Write a short continuation packet for a fresh Claude Code session or a Codex reviewer, covering state, changed files, evidence, blockers and the next action.
argument-hint: "<claude|codex>"
disable-model-invocation: true
---

Write a handoff packet for the `$ARGUMENTS` reader (default: claude).

1. Gather facts with `git status --short`, `git branch --show-current`, `git rev-parse HEAD` and `git diff --stat`. Read the checkpoint.
2. Write `.claude/local/handoff-<date>.md`. Keep it under 500 words. Use these headings:
   - **Identity:** branch, HEAD, approved base, worktree path.
   - **Changed files:** every modified or untracked file, grouped as protected (the five exploratory files) or tooling/other.
   - **Decisions:** what was decided and why, with the reference.
   - **Evidence:** tests and checks, each marked reported or verified, with commands.
   - **Blockers and owner actions:** each one, with what settles it.
   - **Next action:** the single next step and whether it is authorised.
3. Do not include secrets, tokens, private report contents, or reviewer identities. Refer to people by role.
4. Print the file path. Do not print the packet itself.

The packet must not claim CI passed, that a pin is approved, or that any live inference ran.
