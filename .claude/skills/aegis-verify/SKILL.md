---
name: aegis-verify
description: Run AEGIS deterministic checks (lint, typecheck, coverage, build, diff-check, or a scoped test file), capture exit codes and summarise failures.
argument-hint: "[lint|typecheck|coverage|build|diff|all|<test file>]"
disable-model-invocation: true
context: fork
---

Run the requested checks: $ARGUMENTS (default: `all`).

Commands by target, from the repository root:
- `lint`: `npm run lint`
- `typecheck`: `npm run typecheck`
- `coverage`: `npm run test:coverage`
- `build`: `npm run build`
- `diff`: `git diff --check`
- `all`: lint, typecheck, coverage, build, diff, in that order
- any other value: treat it as a test file path and run `npx vitest run <path>` in its workspace

Rules:
- Capture each full log to `.local/verify/<target>-<timestamp>.log` or the scratchpad. Do not print it.
- Record each exit status. A non-zero status is a failure even if the summary looks green.
- For failures, quote only the first failing test or error, with its file and line, and the last summary line.
- Report coverage numbers only as printed by the command.
- Do not stop at the first failure when running `all`; run every check and report all results.

Return, in under 250 words, a table: target, command, exit status, summary line, and the log path.
