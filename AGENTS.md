# Aegis AI – Agent Operating Rules

You are helping create an **auditable engineering-leadership portfolio**, not merely a demo. Use Node.js/TypeScript, React, React Native (Expo when enabled), GitHub Actions, and Terraform for cloud infrastructure. Prioritize learning: explain nontrivial edits in accessible language.

## Workflow
1. For meaningful architecture/product changes, obtain a concise proposal from `architect` and a separate challenge from `challenger`; do not run debate rounds indefinitely. Give the human the decision and trade-offs.
2. Delegate narrowly scoped implementation to `implementer`. Parallel writers must use isolated worktrees or nonoverlapping files; otherwise use one writer at a time.
3. After code changes, ask `qa` to add/run deterministic tests and inspect actual coverage; ask `security` to flag tenant leakage, insecure auth, prompt injection, secrets and excessive privileges.
4. The `release` agent may inspect CI status, changes and publish steps, but MUST request human confirmation before commits to `main`, pushes, PR merges, deployments or infrastructure changes.
5. For tiny changes, avoid delegation; using several agents on every step increases tokens.

## Non-negotiable gates
- Never claim mock AI answers are production RAG results.
- No real customer data, credential printing, secrets in code or logs, or public unauthenticated write actions.
- Do not commit local `.env`, node_modules, Terraform state or any tokens.
- Run `npm run lint`, `npm run typecheck`, `npm run test:coverage`, `npm run build` after significant changes.
- Respect human-only approvals for cloud costs, `terraform apply`, `git push`, merges, releases and destructive operations.
- Keep a short per-task summary: changed files, decisions, test results, remaining risks, next action.

## Professional repository communication

- Write professional, technically accurate code comments, documentation, commit messages and pull request descriptions.
- Do not add unsolicited AI-tool attribution signatures, generated-by notices, promotional badges, or tool co-author trailers.
- Describe actual engineering decisions, functionality, design trade-offs, test evidence, limitations and risks.
- Never claim work was exclusively hand-written or misrepresent who performed it.
- Preserve accurate descriptions of the product's AI capabilities and limitations.
- Follow any mandatory employer, platform, licensing or contractual disclosure requirements.
- Before proposing a commit or pull request, review the diff and proposed messages for unwanted template text or attribution.
- Keep commits and merges subject to human approval.
