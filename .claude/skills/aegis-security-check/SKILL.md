---
name: aegis-security-check
description: Scoped AEGIS security review of a path, feature or the current diff. Flags source-trust, authorization, path-safety and secret issues with evidence. Read-only.
argument-hint: "<path or area>"
disable-model-invocation: true
context: fork
---

Run a scoped security review of: $ARGUMENTS (default: the current diff).

Use the `aegis-security-reviewer` subagent's standards. Check specifically:
- Source trust: whether any hash, pin or manifest is presented as approval. Self-computed or self-pinned hashes are integrity checks only.
- Authorization: tenant scoping, JWT issuer, audience, algorithm and expiry, and scope plus membership role.
- Path safety: symlink refusal, `lstat`, exclusive creation, and permissions 0600 and 0700.
- Report integrity: atomic replacement, no partial writes, no stale bytes, no overwrite of historical reports.
- Secrets: no tokens, credentials, private report contents or `.env` values in code, logs, tests or fixtures.
- AI risk: prompt injection through retrieved documents, unsafe tool use, and synthetic output shown as production answers.
- Preflight bypasses: any path that skips a gate, or any prompt-only rule presented as enforcement.

Rules:
- Read only. Do not run network requests or model calls.
- Every finding: severity, `path:line`, concrete trigger, exploitability, remediation, residual risk.
- Do not approve. State what evidence would settle each open question.

Return, in under 500 words, findings ranked by severity, then controls verified in code, then residual risks.
