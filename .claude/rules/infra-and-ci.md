---
paths:
  - ".github/**"
  - "infra/**"
---

# Infrastructure and CI rules

- Never run `terraform apply`, `terraform destroy` or any command that changes cloud resources. Validation is offline: `terraform fmt -check`, `terraform init -backend=false`, `terraform validate`.
- Never add credentials, tokens or real account identifiers to workflows or Terraform. CI service passwords in `ci.yml` are isolated test-only values; do not reuse them elsewhere.
- Do not weaken a CI gate, coverage threshold or whitespace check to make a change pass. Changes to workflows need human confirmation.
- Terraform state and `.env` files are never committed.
- Domain context: `.claude/context/release.md`. Use `.claude/agents/aegis-release-reviewer` for CI evidence; never claim a run passed without its conclusion for the exact SHA.
