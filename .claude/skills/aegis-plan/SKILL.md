---
name: aegis-plan
description: Break a requested AEGIS change into a small, dependency-aware plan with acceptance criteria and owner-approval points. Does not edit files.
argument-hint: "<change request>"
disable-model-invocation: true
---

Plan this change without editing files: $ARGUMENTS

1. Confirm the request is in scope for the current checkpoint. If it touches a frozen status, a protected file or an owner-only action, say so first.
2. Locate the affected code with Grep and Glob. Read only the line ranges you need. Name the rule files and context namespaces that apply.
3. Produce a numbered plan of at most seven steps. For each step give:
   - The files it touches.
   - The focused test to run.
   - The acceptance criterion, stated so it can be checked.
   - Whether it needs a subagent, and which one.
4. List the owner approvals this change requires, and anything that is blocked.
5. Keep the plan under 400 words. End with the first step to execute.

Do not spawn subagents while planning.
