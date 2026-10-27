export interface DemoResult {
  mode: 'synthetic-mock';
  answer: string;
  citations: Array<{ documentId: string; title: string }>;
  warning: string;
}

/** Intentionally synthetic: not RAG, no LLM API call, no customer data. */
export function answerDemoQuestion(question: string): DemoResult {
  const text = question.trim();
  const isIncident = /incident|outage|error|login|401/i.test(text);
  return {
    mode: 'synthetic-mock',
    answer: isIncident
      ? 'Illustrative only: inspect synthetic incident logs, identify the failing service and escalate for human approval.'
      : 'Illustrative only: a future retrieval service will cite authorized tenant documents before answering.',
    citations: [{ documentId: 'SYNTHETIC-POLICY-001', title: 'Synthetic Support Policy (example only)' }],
    warning: 'Not a real AI answer. Not based on authenticated or retrieved enterprise records.',
  };
}
