# Efficient Codex prompts

## Plan-first (for larger work)
> Evaluate implementing [FEATURE]. Spawn architect and challenger to independently assess feasibility, security, cost, tests and alternative design. Have the parent synthesize one short proposal and acceptance criteria. Do not edit files.

## Controlled implementation
> Implement only acceptance criteria [X] in [TARGET FILES]. Use the implementer agent. Add deterministic unit tests and update docs. Don't touch unrelated files. Run the relevant focused test first. Summarize files changed and evidence.

## QA/security gate
> Have qa and security review the diff against main separately. Run lint, typecheck, coverage and build. List actual findings with file references, measured coverage and blockers; don't silently weaken thresholds.

## PR preparation
> Have release inspect the working tree and CI readiness, draft the PR description and safe commands. Do not push or merge without my explicit approval.

## Context efficiency
- Keep one feature per conversation; start a new focused session if context becomes stale.
- Reference the path or function instead of pasting the entire repository.
- Request at most one architecture + challenge round, only for nontrivial changes.
- Delegate independent read-only investigations in parallel. Avoid multiple agents editing the same files.
- Test commands and concise diffs are cheaper and more reliable than endless agents discussing hypothetical solutions.
- Model/plan limits vary. Subagents typically use **more tokens in aggregate** than a single agent; use them for higher confidence or elapsed-time savings, not as a claimed automatic token discount.
