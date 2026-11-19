# aegis/evaluation

- Code: `apps/api/src/ai/evaluation/` (runners, scorers, dataset, reports, source identity, private report storage).
- Frozen dataset `grounded-balanced-v1`: six synthetic scenarios, three SUPPORTED and three INSUFFICIENT_EVIDENCE, canonical digest `6774f2b6…73bb`. Labels are engineering-authored and not human approved.
- Exploratory track (AI-assisted, separate from qualification): `docs/AI-ASSISTED-EXPLORATORY-EVALUATION-V1.md`. Reports always state `NOT_QUALIFIED`, `humanApprovalStatus: NOT_VERIFIED` and `semantic evidence validation: NOT_ASSESSED`.
- Historical evidence is immutable: `docs/AI-EVALUATION-*.md`, `docs/AI-*-M4.*.md`, and the reports under `.local/` (gitignored, never read by agents).
- The exploratory runner's pinned `reviewedRunnerSha256` is an integrity check. Changing the runner requires an independent review and an owner-approved pin update.
- Human Qualification V1 manifests are separate and must not be read by the exploratory runner.
