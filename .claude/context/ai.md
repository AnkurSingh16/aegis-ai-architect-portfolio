# aegis/ai

- Provider and analysis code: `apps/api/src/ai/provider.ts`, `grounded-provider.ts`, `analysis.ts`, `grounded-analysis.ts`, `priority-evaluation.ts`.
- Local model path: Ollama on loopback only. Use is governed by the owner's live-inference authorization, which is currently NOT AUTHORISED.
- Grounding: local retrieval over synthetic documents (`apps/api/src/documents/`). Decision record: `docs/adr/008-grounded-document-ingestion-and-retrieval.md`; also `006` and `007`.
- Mock or synthetic AI output must never be presented as production RAG results.
- Grounded AI live quality is NOT QUALIFIED (`docs/GROUNDED-AI-QUALIFICATION-V1.md`).
