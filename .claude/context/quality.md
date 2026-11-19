# aegis/quality

- Root gates (run after significant changes): `npm run lint`, `npm run typecheck`, `npm run test:coverage`, `npm run build`. CI also runs `git diff --check`, `npm run test:integration` (PostgreSQL service) and `npm run test:e2e -w apps/web` (Playwright).
- Focused tests: `npx vitest run <file>` inside `apps/api` or `apps/web`.
- Coverage: report measured numbers from command output only. Historical counts in reports are reported results, not verified results for this session.
- Coverage artifacts: `apps/api/coverage/` and `apps/web/coverage/` (uploaded by CI).
- Node test files under `infra/terraform/auth0/` and `apps/api/scripts/` run through the root `npm test`.
