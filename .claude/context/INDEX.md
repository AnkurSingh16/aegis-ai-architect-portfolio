# AEGIS context index

Load one namespace at a time, and only when the task depends on it. Each file points to repository sources rather than copying them.

| Namespace | File | Load when |
| --- | --- | --- |
| aegis/core | `core.md` | Architecture, modules, accepted MVP |
| aegis/api | `api.md` | Fastify routes, contracts, runtime |
| aegis/identity | `identity.md` | Auth0, JWT, memberships |
| aegis/ai | `ai.md` | Providers, grounding, retrieval, orchestration |
| aegis/evaluation | `evaluation.md` | Benchmarks, contracts, reports |
| aegis/security | `security.md` | Threat boundaries, protected operations |
| aegis/quality | `quality.md` | Tests, coverage, validation commands |
| aegis/release | `release.md` | Git, CI, PRs, approval gates |
| aegis/portfolio | `portfolio.md` | Roadmap, demonstration requirements |

Do not load `identity.md`, `evaluation.md` or `release.md` for a UI-only change. The path-scoped rules in `.claude/rules/` already load the right safety guidance for the files you touch.
