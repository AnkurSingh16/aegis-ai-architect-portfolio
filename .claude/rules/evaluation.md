---
paths:
  - "apps/api/src/ai/**"
  - "docs/AI-*.md"
  - "docs/GROUNDED-*.md"
---

# AI and evaluation rules

- No live inference. Tests use mocked providers. Do not run Ollama or any model from an agent session.
- Frozen datasets, reports and historical evaluation documents are evidence. Do not edit them. New work gets a new file.
- Labels in the frozen dataset are engineering-authored. Critiques by AI models are reported provenance, not human approval. Report `humanApprovalStatus` as NOT_VERIFIED unless a human approval is verified.
- Keep the distinction explicit: schema or parser success is not semantic correctness, and synthetic agreement is not qualification.
- Pinned hashes are integrity checks. A hash that a repository file computes or pins about itself is not independent trust evidence.
- Domain context: `.claude/context/ai.md` and `.claude/context/evaluation.md`. Use `security.md` when the change touches report writing or source identity.
