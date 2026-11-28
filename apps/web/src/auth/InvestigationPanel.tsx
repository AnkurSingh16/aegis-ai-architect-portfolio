import { useEffect, useRef, useState } from 'react';
import { useSession } from './session';

/**
 * Evidence-backed investigation. Every request goes through the authenticated API. The browser holds no agent endpoint, no SPIRE socket
 * and no database credential. The idempotency key is created once per question and reused for retries, so a retry after a lost response
 * returns the same execution rather than a second one.
 */

const tenants = [
  { id: '10000000-0000-4000-8000-000000000001', name: 'Synthetic North' },
  { id: '20000000-0000-4000-8000-000000000002', name: 'Synthetic South' },
] as const;

export const TERMINAL_STAGES = ['completed', 'insufficient_evidence', 'failed', 'cancelled'] as const;
export const isTerminalStage = (stage: string): boolean => (TERMINAL_STAGES as readonly string[]).includes(stage);

const STAGE_LABELS: Record<string, string> = {
  submitted: 'Submitted', triage_requested: 'Triage planning', plan_received: 'Plan received', retrieval_requested: 'Retrieving evidence',
  evidence_received: 'Evidence received', review_requested: 'Reviewer checking the answer', review_received: 'Review received',
  completed: 'Completed', insufficient_evidence: 'Insufficient evidence', failed: 'Failed', cancelled: 'Cancelled',
};
export const stageLabel = (stage: string): string => STAGE_LABELS[stage] ?? 'Processing';

export interface InvestigationView {
  executionId: string;
  stage: string;
  status: string;
  cancelRequested: boolean;
  result: null | { verdict: 'answered' | 'insufficient_evidence' | 'failed'; answer: string | null;
    citations: Array<{ ref: string }>; reviewerDecision: string; failureReason: string | null };
}

type Phase = { kind: 'idle' } | { kind: 'submitting' } | { kind: 'tracking'; executionId: string; tenantId: string }
  | { kind: 'error'; message: string };

const MESSAGES: Record<number, string> = {
  400: 'The question could not be accepted. Check its length (1 to 1000 characters).',
  401: 'Your session is no longer valid. Sign in again to continue.',
  403: 'You are not authorised to investigate for this tenant.',
  404: 'That investigation was not found.',
  409: 'This request key was already used for a different question. Start a new request.',
};

export default function InvestigationPanel() {
  const session = useSession();
  const [tenantId, setTenantId] = useState<string>(tenants[0].id);
  const [question, setQuestion] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [view, setView] = useState<InvestigationView | null>(null);
  // The key for the question being submitted. Reused by a retry of the same question; replaced when the question changes.
  const keyRef = useRef<{ question: string; tenantId: string; key: string } | null>(null);

  async function call(path: string, init: RequestInit): Promise<Response> {
    const token = await session.getAccessToken();
    return fetch(path, { ...init, headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = question.trim();
    if (trimmed.length < 1 || trimmed.length > 1000) { setPhase({ kind: 'error', message: MESSAGES[400] }); return; }
    if (!keyRef.current || keyRef.current.question !== trimmed || keyRef.current.tenantId !== tenantId) {
      keyRef.current = { question: trimmed, tenantId, key: crypto.randomUUID() };
    }
    setPhase({ kind: 'submitting' });
    try {
      const response = await call(`/api/tenants/${tenantId}/investigations`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': keyRef.current.key }, body: JSON.stringify({ question: trimmed }) });
      if (!response.ok) { setPhase({ kind: 'error', message: MESSAGES[response.status] ?? 'The investigation service is unavailable. Retry the same request.' }); return; }
      const body = await response.json() as { executionId: string };
      setView(null);
      setPhase({ kind: 'tracking', executionId: body.executionId, tenantId });
    } catch {
      setPhase({ kind: 'error', message: 'The investigation service is unavailable. Retry the same request; it will not create a second investigation.' });
    }
  }

  useEffect(() => {
    if (phase.kind !== 'tracking') return;
    let active = true;
    const poll = async () => {
      try {
        const response = await call(`/api/tenants/${phase.tenantId}/investigations/${phase.executionId}`, { method: 'GET' });
        if (!response.ok) { if (active) setPhase({ kind: 'error', message: MESSAGES[response.status] ?? 'Status is unavailable.' }); return; }
        const next = await response.json() as InvestigationView;
        if (!active) return;
        setView(next);
        if (!isTerminalStage(next.stage)) window.setTimeout(() => { if (active) void poll(); }, 2000);
      } catch {
        if (active) window.setTimeout(() => { if (active) void poll(); }, 4000);
      }
    };
    void poll();
    return () => { active = false; };
    // The poll is tied to the tracked execution only.
  }, [phase.kind === 'tracking' ? phase.executionId : null]);

  async function cancel() {
    if (phase.kind !== 'tracking') return;
    const response = await call(`/api/tenants/${phase.tenantId}/investigations/${phase.executionId}/cancel`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'user_request' }) });
    if (!response.ok) setPhase({ kind: 'error', message: MESSAGES[response.status] ?? 'Cancellation could not be requested.' });
  }

  if (session.status !== 'authenticated') {
    return (
      <section className="investigation wrap" aria-labelledby="investigation-heading">
        <h2 id="investigation-heading">Evidence-backed investigation</h2>
        <p>Sign in to submit an investigation for a tenant you are authorised to use.</p>
        <button className="auth-button" onClick={() => void session.signIn()}>Sign in</button>
      </section>
    );
  }

  const busy = phase.kind === 'submitting';
  return (
    <section className="investigation wrap" aria-labelledby="investigation-heading">
      <h2 id="investigation-heading">Evidence-backed investigation</h2>
      <form onSubmit={(e) => void submit(e)}>
        <label>Tenant
          <select value={tenantId} onChange={(e) => setTenantId(e.target.value)} disabled={busy}>
            {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        <label>Question
          <textarea value={question} maxLength={1000} rows={3} onChange={(e) => setQuestion(e.target.value)} disabled={busy}
            placeholder="For example: which procedure applies to an account recovery request document?" />
        </label>
        <button type="submit" className="auth-button" disabled={busy || question.trim().length === 0}>
          {busy ? 'Submitting…' : 'Investigate'}
        </button>
      </form>
      {phase.kind === 'error' && <p role="alert">{phase.message}</p>}
      {phase.kind === 'tracking' && <div aria-live="polite">
        <p>Execution <code>{phase.executionId}</code></p>
        {view && <>
          <p>Status: <strong>{stageLabel(view.stage)}</strong></p>
          {!isTerminalStage(view.stage) && !view.cancelRequested && <button className="auth-button secondary" onClick={() => void cancel()}>Cancel</button>}
          {view.cancelRequested && !isTerminalStage(view.stage) && <p>Cancellation requested. The orchestrator will finalise it; the investigation shows as cancelled once it does.</p>}
          {view.result?.verdict === 'answered' && <section aria-labelledby="answer-heading">
            <h3 id="answer-heading">Answer (reviewer approved)</h3>
            <p>{view.result.answer}</p>
            <h4>Cited sources</h4>
            <ul>{view.result.citations.map((c) => <li key={c.ref}><code>{c.ref}</code></li>)}</ul>
          </section>}
          {view.result?.verdict === 'insufficient_evidence' && <p role="status">Insufficient evidence: the authorised documents do not answer this question. No answer is given.</p>}
          {view.result?.verdict === 'failed' && <p role="alert">The investigation failed ({view.result.failureReason ?? 'unknown reason'}). No answer is given.</p>}
        </>}
      </div>}
    </section>
  );
}
