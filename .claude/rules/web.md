---
paths:
  - "apps/web/**"
---

# Web rules

- UI work does not need identity, evaluation or infrastructure context. Load those only when a real dependency appears in the change.
- Do not display AI output as production answers. Synthetic or mocked responses must be labelled as such.
- Do not store tokens in `localStorage` or log them. Authentication calls go through the existing auth modules.
- Keep tests colocated with components. The browser workflow suite runs with `npm run test:e2e -w apps/web` and mocks identity and API.
- Focused check: `npm run test -w apps/web`. Full gates: see `.claude/CLAUDE.md`.
