---
paths:
  - "apps/api/src/auth/**"
  - "apps/api/src/storage/**"
  - "apps/api/src/ai/evaluation/private-report.ts"
  - "apps/api/src/ai/evaluation/source-identity.ts"
  - "apps/api/src/ai/evaluation/ai-assisted-exploratory-evaluation-v1*.ts"
  - "apps/api/src/ai/evaluation/run-ai-assisted-exploratory-evaluation-v1-local.ts"
---

# Security-sensitive code

- Fail closed. Any unexpected state, missing evidence or parse ambiguity must reject, not fall back.
- Path safety: refuse symbolic links, check parent permissions with `lstat`, and create private reports exclusively (`wx`, mode 0600 in 0700 directories).
- Writes that replace a report must not follow a symlink or leave partial output. Use the atomic replace helper, not an in-place rewrite.
- JWT: RS256 only, exact issuer and audience, required subject and expiry. Scopes authorize; role claims do not.
- Never log, print or persist tokens, credentials, prompts, raw model responses or private report contents.
- Hashes or pins in the repository are integrity checks only. Do not present them as approval, and do not weaken a check to make a test pass.
- After changes here, invoke `/aegis-security-check` or the `aegis-security-reviewer` subagent. Do not self-approve.
- Domain context: `.claude/context/security.md`, and `identity.md` for `auth/`.
