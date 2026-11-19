# aegis/security

- Security runbook: `docs/SECURITY-RUNBOOK.md`. Release checklist: `docs/RELEASE-CHECKLIST.md`.
- Protected operations need human approval: cloud spend, `terraform apply`, `git push`, merges, releases, deployments, destructive operations.
- Source trust is BLOCKED. Repository hashes can be modified and recomputed together, so they are not an approval root. External signing or verifier material and owner approval are required (see the trust design in `docs/AI-ASSISTED-EXPLORATORY-EVALUATION-V1.md`).
- Path safety rules: exclusive creation, symlink refusal, 0700 directories and 0600 files (`apps/api/src/ai/evaluation/private-report.ts`).
- Report writes that replace existing content use write-then-rename (`replacePrivateReportAtomically`). Rename is atomic on one filesystem; power-loss durability is not separately tested.
- Prompt-level instructions are not enforced controls. Enforcement lives in code, tests and the permission rules in `.claude/settings.json`.
