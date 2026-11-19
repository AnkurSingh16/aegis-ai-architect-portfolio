---
name: aegis-review
description: Review the current AEGIS diff against the task requirements, tests, coding standards and security boundaries. Read-only; reports findings only.
argument-hint: "[base ref, default HEAD]"
disable-model-invocation: true
context: fork
---

Review the working-tree diff against the base ref given here: $ARGUMENTS. If that is empty, use HEAD. Read-only.

1. Run `git status --short` and `git diff --stat <base>` for the scope.
2. Read the diff in pieces. Do not paste the full diff into the report.
3. Check, for each changed file:
   - Matches the stated requirement and touches no out-of-scope file.
   - Has a focused test that would fail without the change.
   - Follows the surrounding naming and idiom.
   - Respects `.claude/rules/` for its path.
   - Does not weaken a gate, pin, assertion, or frozen artifact.
   - Adds no secret, token, real data, or generated-by attribution.
4. Rank findings Critical, High, Medium, Low, Informational. Each needs `path:line` and evidence.
5. If a finding touches authentication, authorization, paths, reports or source identity, recommend `/aegis-security-check`.

Return, in under 400 words: a findings list, then "No blocking findings" or the blockers. Do not edit files.
