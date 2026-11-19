---
name: aegis-implement
description: Execute one focused, approved AEGIS engineering task, run its focused tests and report changed files. Requires an explicit task description.
argument-hint: "<approved task>"
disable-model-invocation: true
---

Implement this approved task: $ARGUMENTS

Before editing:
1. Confirm the task names a scope and acceptance criterion. If it does not, stop and ask for them.
2. Confirm no protected file is in scope (the five exploratory files unless the task names them, historical evidence, frozen datasets, pinned hashes, `infra/` apply paths, `.github/` workflows). Stop and ask if one is.
3. Find existing patterns with Grep, then read only the relevant ranges.

While editing:
4. Make the smallest change that satisfies the criterion. Match the surrounding naming, comment density and idiom.
5. Add or adjust deterministic tests for the changed behaviour. Do not weaken an assertion.
6. Run the focused test file. Fix real failures; report any you cannot fix.

Finish with, under 250 words:
- Changed files, one line each.
- Test commands run, with exit status and summary line.
- Anything not verified, and the next step.

Do not commit, push, stage, stash, or run the full gates unless the task asks for them. Suggest `/aegis-verify` next.
