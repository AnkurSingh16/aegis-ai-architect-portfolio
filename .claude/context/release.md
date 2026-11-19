# aegis/release

- CI: `.github/workflows/ci.yml` on pull requests and pushes to `main`. Jobs: lint, typecheck, coverage, Playwright workflow tests, PostgreSQL integration, build, whitespace check, offline Auth0 Terraform validation.
- Release checklist: `docs/RELEASE-CHECKLIST.md`. Codex release role: `.codex/agents/release.toml`.
- Human-only actions: commit to `main`, push, PR merge, deployment, `terraform apply`, DNS change, publishing.
- Evidence rule: a CI claim needs the run conclusion for the exact commit SHA. "Local tests passed" is not CI evidence.
- Commit and PR text must not contain generated-by notices or template attribution (see `AGENTS.md`). Attribution trailers from tooling are added only when the owner has specified them.
- The exploratory branch `feat/ai-assisted-exploratory-evaluation-v1` has five protected uncommitted files and is not ready for a PR until the owner's review and the pin decision are complete.
