import { useEffect, useRef, useState } from 'react';
import { Auth0Provider, useAuth0 } from '@auth0/auth0-react';
import type { AuthConfig } from './config';
import { isApprovedLoopbackOrigin } from './config';
import { isAnalysisResult, type AnalysisResult } from '../../../api/src/ai/analysis.js';
import { isGroundedAnalysisResult, type GroundedAnalysisResult } from '../../../api/src/ai/grounded-analysis.js';

const tenants = [
  { id: '10000000-0000-4000-8000-000000000001', name: 'Synthetic North' },
  { id: '20000000-0000-4000-8000-000000000002', name: 'Synthetic South' },
] as const;

type StoredCase = {
  id: string;
  tenant_id: string;
  synthetic_case_id: string;
  status: string;
  created_at: string;
  updated_at: string;
};

type ViewState = { kind: 'idle' | 'loading' | 'ready' | 'unauthenticated' | 'forbidden' | 'unavailable'; cases: StoredCase[]; canReview?: boolean; message?: string };
type AnalysisState = { kind: 'idle' | 'loading' | 'disabled' | 'success' | 'unauthenticated' | 'forbidden' | 'failed'; caseId?: string; result?: AnalysisResult };
type GroundedState = { kind: 'idle' | 'loading' | 'disabled' | 'success' | 'insufficient' | 'unauthenticated' | 'forbidden' |
  'validationFailed' | 'providerUnavailable' | 'failed'; caseId?: string; result?: GroundedAnalysisResult };
type ReviewDecision = 'approve' | 'reject' | 'defer';
type CaseReview = { review_id: string; tenant_id: string; case_id: string; decision: ReviewDecision;
  actor_issuer: string; actor_subject: string; note: string | null; created_at: string };
type ReviewView = { kind: 'idle' | 'loading' | 'ready' | 'unauthenticated' | 'forbidden' | 'notFound' | 'unavailable'; history: CaseReview[] };
type ReviewSubmit = { kind: 'idle' | 'confirm' | 'submitting' | 'success' | 'unauthenticated' | 'forbidden' | 'notFound' | 'invalid' | 'conflict' | 'unavailable';
  decision?: ReviewDecision; note: string; idempotencyKey?: string; attempted?: boolean; retryable?: boolean };

function isCaseReview(value: unknown, tenantId: string, caseId: string): value is CaseReview {
  if (!value || typeof value !== 'object') return false;
  const review = value as Record<string, unknown>;
  return review.tenant_id === tenantId && review.case_id === caseId && typeof review.review_id === 'string' &&
    ['approve', 'reject', 'defer'].includes(String(review.decision)) && typeof review.actor_issuer === 'string' &&
    typeof review.actor_subject === 'string' && (review.note === null || typeof review.note === 'string') &&
    typeof review.created_at === 'string' && Number.isFinite(Date.parse(review.created_at));
}

function reviewErrorKind(status: number): ReviewSubmit['kind'] {
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'notFound';
  if (status === 400) return 'invalid';
  if (status === 409) return 'conflict';
  return 'unavailable';
}

function reviewHistoryErrorKind(status: number): ReviewView['kind'] {
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'notFound';
  return 'unavailable';
}

function reviewErrorMessage(kind: ReviewSubmit['kind'] | ReviewView['kind']): string {
  if (kind === 'unauthenticated') return 'Your session is no longer authorized. Sign in again to continue.';
  if (kind === 'forbidden') return 'Review access was denied for this tenant or your account is read-only.';
  if (kind === 'notFound') return 'This case is no longer available in the selected tenant.';
  if (kind === 'invalid') return 'The review request was invalid. Check the note length and try again.';
  if (kind === 'conflict') return 'This review request conflicted with an earlier submission. Reload the history before continuing.';
  return 'Review history or submission is unavailable. Please retry.';
}

function HumanCaseReview({ tenantId, item, canReview }: { tenantId: string; item: StoredCase; canReview: boolean }) {
  const { getAccessTokenSilently } = useAuth0();
  const [expanded, setExpanded] = useState(false);
  const [history, setHistory] = useState<ReviewView>({ kind: 'idle', history: [] });
  const [submission, setSubmission] = useState<ReviewSubmit>({ kind: 'idle', note: '' });
  const historyGeneration = useRef(0);
  const historyController = useRef<AbortController | undefined>(undefined);
  const submitController = useRef<AbortController | undefined>(undefined);
  const submitting = useRef(false);
  const outcomeUncertain = submission.attempted === true && submission.retryable === true;

  useEffect(() => () => {
    historyGeneration.current++;
    historyController.current?.abort();
    submitController.current?.abort();
  }, [tenantId, item.id]);

  async function loadHistory() {
    historyController.current?.abort();
    const generation = ++historyGeneration.current;
    const controller = new AbortController();
    historyController.current = controller;
    setHistory({ kind: 'loading', history: [] });
    try {
      const token = await getAccessTokenSilently();
      if (controller.signal.aborted || generation !== historyGeneration.current) return;
      if (!token) { setHistory({ kind: 'unauthenticated', history: [] }); return; }
      const response = await fetch(`/api/tenants/${encodeURIComponent(tenantId)}/cases/${encodeURIComponent(item.id)}/reviews`, {
        method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal,
      });
      if (controller.signal.aborted || generation !== historyGeneration.current) return;
      if (!response.ok) { setHistory({ kind: reviewHistoryErrorKind(response.status), history: [] }); return; }
      const body: unknown = await response.json();
      if (controller.signal.aborted || generation !== historyGeneration.current) return;
      if (!Array.isArray(body) || body.length > 100 || !body.every((row) => isCaseReview(row, tenantId, item.id))) {
        setHistory({ kind: 'unavailable', history: [] }); return;
      }
      setHistory({ kind: 'ready', history: body });
    } catch {
      if (!controller.signal.aborted && generation === historyGeneration.current) setHistory({ kind: 'unavailable', history: [] });
    } finally {
      if (historyController.current === controller) historyController.current = undefined;
    }
  }

  function beginDecision(decision: ReviewDecision) {
    setSubmission({ kind: 'confirm', decision, note: '', idempotencyKey: crypto.randomUUID() });
  }

  async function submitDecision(candidate: ReviewSubmit = submission) {
    if (submitting.current || candidate.kind !== 'confirm' || !candidate.decision || !candidate.idempotencyKey || candidate.attempted) return;
    submitting.current = true;
    const controller = new AbortController();
    submitController.current = controller;
    const request = { ...candidate, kind: 'submitting' as const, attempted: true };
    setSubmission(request);
    try {
      const token = await getAccessTokenSilently();
      if (controller.signal.aborted) return;
      if (!token) { setSubmission({ ...request, kind: 'unauthenticated' }); return; }
      const response = await fetch(`/api/tenants/${encodeURIComponent(tenantId)}/cases/${encodeURIComponent(item.id)}/reviews`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json',
          'Idempotency-Key': candidate.idempotencyKey },
        body: JSON.stringify({ decision: candidate.decision, ...(candidate.note ? { note: candidate.note } : {}) }),
        credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (response.status !== 201 && response.status !== 200) {
        setSubmission({ ...request, kind: reviewErrorKind(response.status), retryable: response.status >= 500 }); return;
      }
      const body: unknown = await response.json();
      if (controller.signal.aborted) return;
      if (!isCaseReview(body, tenantId, item.id)) { setSubmission({ ...request, kind: 'unavailable' }); return; }
      setSubmission({ kind: 'success', note: '' });
      setExpanded(true);
      await loadHistory();
    } catch {
      if (!controller.signal.aborted) setSubmission({ ...request, kind: 'unavailable', retryable: true });
    } finally {
      submitting.current = false;
      if (submitController.current === controller) submitController.current = undefined;
    }
  }

  return <section className="case-review" aria-labelledby={`review-title-${item.id}`}>
    <h4 id={`review-title-${item.id}`}>Human case review</h4>
    {canReview && !outcomeUncertain && <div className="case-review-actions" aria-label="Choose a human case review decision">
      {(['approve', 'reject', 'defer'] as const).map((decision) => <button key={decision} type="button" className="auth-button secondary"
        disabled={submission.kind === 'submitting'} onClick={() => beginDecision(decision)}>{decision[0].toUpperCase() + decision.slice(1)}</button>)}
    </div>}
    {!canReview && <p className="auth-note">You can view review history but cannot submit a decision.</p>}
    {(submission.kind === 'confirm' || submission.kind === 'submitting' || submission.attempted) && submission.decision && <fieldset>
      <legend>Confirm {submission.decision} decision</legend>
      <label htmlFor={`review-note-${item.id}`}>Optional reviewer note</label>
      <textarea id={`review-note-${item.id}`} maxLength={1000} value={submission.note} disabled={submission.attempted}
        onChange={(event) => setSubmission((current) => ({ ...current, note: event.target.value }))} />
      {submission.kind === 'submitting' ? <p role="status">Submitting review…</p> : submission.attempted ? <>
        <p role="alert">{reviewErrorMessage(submission.kind)}</p>
        {submission.retryable && <p>Keep this review open and retry the same request to determine whether it was saved.</p>}
        {submission.retryable && <button type="button" className="auth-button secondary"
          onClick={() => void submitDecision({ ...submission, kind: 'confirm', attempted: false })}>Retry same decision</button>}
        {!submission.retryable && <button type="button" className="auth-button secondary" onClick={() => setSubmission({ kind: 'idle', note: '' })}>Choose another decision</button>}
      </> : <>
        <p>This records a human decision only. It does not approve an AI recommendation, change case status, or perform an action.</p>
        <button type="button" className="auth-button primary" onClick={() => void submitDecision()}>Confirm review</button>
      </>}
      {submission.kind !== 'submitting' && !submission.retryable && <button type="button" className="auth-button secondary" onClick={() => setSubmission({ kind: 'idle', note: '' })}>Cancel</button>}
    </fieldset>}
    {submission.kind === 'success' && <p role="status">Human review saved.</p>}
    <button type="button" className="auth-button secondary" aria-expanded={expanded}
      onClick={() => { const next = !expanded; setExpanded(next); if (next && history.kind !== 'ready' && history.kind !== 'loading') void loadHistory(); }}>
      {expanded ? 'Hide review history' : 'Show review history'}
    </button>
    {expanded && <div aria-live="polite">
      {history.kind === 'loading' && <p role="status">Loading review history…</p>}
      {history.kind !== 'idle' && history.kind !== 'loading' && history.kind !== 'ready' && <p role="alert">{reviewErrorMessage(history.kind)}</p>}
      {history.kind === 'ready' && <>
        <h5>Latest decision</h5>
        <p>{history.history.at(-1)?.decision ?? 'No decisions recorded.'}</p>
        <h5>Review history</h5>
        {history.history.length === 0 ? <p>No human reviews have been recorded.</p> : <ol>
          {history.history.map((review) => <li key={review.review_id}>
            <strong>{review.decision}</strong> by {review.actor_issuer} · {review.actor_subject} at {new Date(review.created_at).toLocaleString()}
            {review.note && <p>{review.note}</p>}
          </li>)}
        </ol>}
      </>}
    </div>}
  </section>;
}

function isStoredCase(value: unknown, tenantId: string): value is StoredCase {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return item.tenant_id === tenantId && typeof item.id === 'string' &&
    typeof item.synthetic_case_id === 'string' && typeof item.status === 'string' &&
    typeof item.created_at === 'string' && typeof item.updated_at === 'string';
}

function CaseAccessPanel() {
  const { isAuthenticated, isLoading, user, error, loginWithRedirect, logout, getAccessTokenSilently } = useAuth0();
  const [tenantId, setTenantId] = useState<string>(tenants[0].id);
  const [view, setView] = useState<ViewState>({ kind: 'idle', cases: [] });
  const [analysis, setAnalysis] = useState<AnalysisState>({ kind: 'idle' });
  const [grounded, setGrounded] = useState<GroundedState>({ kind: 'idle' });
  const requestGeneration = useRef(0);
  const analysisGeneration = useRef(0);
  const analysisController = useRef<AbortController | undefined>(undefined);
  const groundedController = useRef<AbortController | undefined>(undefined);
  const selectedTenant = tenants.find((tenant) => tenant.id === tenantId) ?? tenants[0];

  useEffect(() => {
    const generation = ++requestGeneration.current;
    analysisGeneration.current++;
    analysisController.current?.abort();
    analysisController.current = undefined;
    groundedController.current?.abort();
    groundedController.current = undefined;
    setAnalysis({ kind: 'idle' });
    setGrounded({ kind: 'idle' });
    setView({ kind: 'idle', cases: [] });
    if (!isAuthenticated) return;
    let active = true;
    const controller = new AbortController();
    setView({ kind: 'loading', cases: [] });

    void (async () => {
      try {
        let token: string | undefined;
        try {
          token = await getAccessTokenSilently();
        } catch {
          if (active && generation === requestGeneration.current) setView({ kind: 'unauthenticated', cases: [] });
          return;
        }
        if (!token) {
          if (active && generation === requestGeneration.current) setView({ kind: 'unauthenticated', cases: [] });
          return;
        }
        if (!active || generation !== requestGeneration.current) return;
        const response = await fetch(`/api/tenants/${encodeURIComponent(tenantId)}/cases`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          credentials: 'omit',
          redirect: 'error',
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!active || generation !== requestGeneration.current) return;
        if (response.status === 401) return setView({ kind: 'unauthenticated', cases: [] });
        if (response.status === 403) return setView({ kind: 'forbidden', cases: [] });
        if (!response.ok) return setView({ kind: 'unavailable', cases: [] });
        const body: unknown = await response.json();
        if (!active || generation !== requestGeneration.current) return;
        if (!Array.isArray(body) || body.length > 100 || !body.every((item) => isStoredCase(item, tenantId))) {
          return setView({ kind: 'unavailable', cases: [] });
        }
        setView({ kind: 'ready', cases: body, canReview: response.headers?.get('X-Aegis-Can-Review') === 'true' });
      } catch {
        if (active && generation === requestGeneration.current) setView({ kind: 'unavailable', cases: [] });
      }
    })();

    return () => {
      active = false;
      controller.abort();
      analysisGeneration.current++;
      analysisController.current?.abort();
      analysisController.current = undefined;
      groundedController.current?.abort();
      groundedController.current = undefined;
    };
  }, [getAccessTokenSilently, isAuthenticated, tenantId, user?.sub]);

  function changeTenant(nextTenant: string) {
    requestGeneration.current += 1;
    analysisGeneration.current += 1;
    analysisController.current?.abort();
    analysisController.current = undefined;
    groundedController.current?.abort();
    groundedController.current = undefined;
    setAnalysis({ kind: 'idle' });
    setGrounded({ kind: 'idle' });
    setView({ kind: 'idle', cases: [] });
    setTenantId(nextTenant);
  }

  async function analyzeCase(caseId: string) {
    groundedController.current?.abort();
    groundedController.current = undefined;
    setGrounded({ kind: 'idle' });
    analysisController.current?.abort();
    const generation = ++analysisGeneration.current;
    const controller = new AbortController();
    analysisController.current = controller;
    setAnalysis({ kind: 'loading', caseId });
    const stillCurrent = () => generation === analysisGeneration.current && !controller.signal.aborted;
    try {
      const token = await getAccessTokenSilently();
      if (!stillCurrent()) return;
      if (!token) { setAnalysis({ kind: 'unauthenticated', caseId }); return; }
      const response = await fetch(`/api/tenants/${encodeURIComponent(tenantId)}/cases/${encodeURIComponent(caseId)}/ai-analysis`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        credentials: 'omit', redirect: 'error', signal: controller.signal,
      });
      if (!stillCurrent()) return;
      if (response.status === 401) { setAnalysis({ kind: 'unauthenticated', caseId }); return; }
      if (response.status === 403) { setAnalysis({ kind: 'forbidden', caseId }); return; }
      if (response.status === 503) {
        const body = await response.json().catch(() => undefined) as { code?: unknown } | undefined;
        if (!stillCurrent()) return;
        setAnalysis({ kind: body?.code === 'ai_analysis_disabled' ? 'disabled' : 'failed', caseId });
        return;
      }
      if (!response.ok) { setAnalysis({ kind: 'failed', caseId }); return; }
      const body: unknown = await response.json();
      if (!stillCurrent()) return;
      if (!isAnalysisResult(body, caseId)) { setAnalysis({ kind: 'failed', caseId }); return; }
      setAnalysis({ kind: 'success', caseId, result: body });
    } catch {
      if (stillCurrent()) setAnalysis({ kind: 'failed', caseId });
    } finally {
      if (analysisController.current === controller) analysisController.current = undefined;
    }
  }

  async function analyzeGroundedCase(caseId: string) {
    analysisController.current?.abort();
    analysisController.current = undefined;
    setAnalysis({ kind: 'idle' });
    groundedController.current?.abort();
    const generation = ++analysisGeneration.current;
    const controller = new AbortController();
    groundedController.current = controller;
    setGrounded({ kind: 'loading', caseId });
    const stillCurrent = () => generation === analysisGeneration.current && !controller.signal.aborted;
    try {
      const token = await getAccessTokenSilently();
      if (!stillCurrent()) return;
      if (!token) { setGrounded({ kind: 'unauthenticated', caseId }); return; }
      const response = await fetch(`/api/tenants/${encodeURIComponent(tenantId)}/cases/${encodeURIComponent(caseId)}/grounded-analysis`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        credentials: 'omit', redirect: 'error', signal: controller.signal,
      });
      if (!stillCurrent()) return;
      if (response.status === 401) { setGrounded({ kind: 'unauthenticated', caseId }); return; }
      if (response.status === 403) { setGrounded({ kind: 'forbidden', caseId }); return; }
      if (response.status === 503) {
        const body = await response.json().catch(() => undefined) as { code?: unknown } | undefined;
        if (!stillCurrent()) return;
        const kind = body?.code === 'ai_analysis_disabled' ? 'disabled'
          : body?.code === 'grounded_analysis_validation_failed' ? 'validationFailed'
            : body?.code === 'grounded_analysis_provider_unavailable' ? 'providerUnavailable' : 'failed';
        setGrounded({ kind, caseId });
        return;
      }
      if (!response.ok) { setGrounded({ kind: 'failed', caseId }); return; }
      const body: unknown = await response.json();
      if (!stillCurrent() || !isGroundedAnalysisResult(body, caseId)) { if (stillCurrent()) setGrounded({ kind: 'failed', caseId }); return; }
      setGrounded({ kind: body.groundingState === 'INSUFFICIENT_EVIDENCE' ? 'insufficient' : 'success', caseId, result: body });
    } catch {
      if (stillCurrent()) setGrounded({ kind: 'failed', caseId });
    } finally {
      if (groundedController.current === controller) groundedController.current = undefined;
    }
  }

  async function signOut() {
    requestGeneration.current += 1;
    analysisGeneration.current += 1;
    analysisController.current?.abort();
    analysisController.current = undefined;
    groundedController.current?.abort();
    groundedController.current = undefined;
    setAnalysis({ kind: 'idle' });
    setGrounded({ kind: 'idle' });
    setView({ kind: 'idle', cases: [] });
    try {
      await logout({ logoutParams: { returnTo: 'http://127.0.0.1:5173' } });
    } catch {
      setView({ kind: 'unavailable', cases: [], message: 'Sign-out could not be completed. Retry or close this development tab.' });
    }
  }

  async function signIn() {
    try {
      await loginWithRedirect();
    } catch {
      setView({ kind: 'unavailable', cases: [], message: 'Sign-in could not be started. Check the local Auth0 development configuration and retry.' });
    }
  }

  const callbackPending = new URLSearchParams(window.location.search).has('code') &&
    new URLSearchParams(window.location.search).has('state');

  return (
    <section className="auth-cases wrap" id="secure-cases" aria-labelledby="auth-cases-title">
      <div className="auth-cases-heading">
        <div><p className="eyebrow">DEVELOPMENT AUTHENTICATION</p><h2 id="auth-cases-title">Protected case access</h2></div>
        {isAuthenticated && <button type="button" className="auth-button secondary" onClick={() => void signOut()}>Sign out</button>}
      </div>
      {isLoading ? <p role="status">{callbackPending ? 'Completing secure sign-in…' : 'Checking sign-in status…'}</p> : !isAuthenticated ? (
        <div className="auth-card"><p>Sign in to request access to synthetic cases. The API checks your identity, scope, tenant membership and row-level policy.</p>
          {error && <p role="alert">Auth0 sign-in could not be completed. Check the local Auth0 settings and try again.</p>}
          <button type="button" className="auth-button primary" onClick={() => void signIn()}>Sign in with Auth0</button>
          {view.kind === 'unavailable' && <p role="alert">{view.message ?? 'The development service is unavailable.'}</p>}
        </div>
      ) : (
        <div className="auth-card">
          <label htmlFor="case-tenant">Requested tenant</label>
          <select id="case-tenant" value={tenantId} onChange={(event) => changeTenant(event.target.value)}>
            {tenants.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.name}</option>)}
          </select>
          <p className="auth-note">This selection only requests a tenant. The API decides whether your account may access it.</p>
          {view.kind === 'loading' && <p role="status">Loading authorized cases…</p>}
          {view.kind === 'ready' && <div aria-live="polite">
            <h3>{selectedTenant.name} cases</h3>
            {view.cases.length === 0 ? <p>No cases are available to this account.</p> : <ul className="case-list">
              {view.cases.map((item) => <li key={item.id} className="case-list-item"><div><strong>{item.synthetic_case_id}</strong><span>{item.status}</span></div>
                <HumanCaseReview key={`${tenantId}:${item.id}`} tenantId={tenantId} item={item} canReview={view.canReview === true} />
                <button type="button" className="auth-button secondary" disabled={analysis.kind === 'loading' || grounded.kind === 'loading'}
                  onClick={() => void analyzeCase(item.id)}>Analyze with local AI</button>
                <button type="button" className="auth-button secondary" disabled={analysis.kind === 'loading' || grounded.kind === 'loading'}
                  onClick={() => void analyzeGroundedCase(item.id)}>Analyze with grounded documents</button>
                {analysis.caseId === item.id && analysis.kind === 'loading' && <p role="status">Analyzing this authorized synthetic case…</p>}
                {analysis.caseId === item.id && analysis.kind === 'disabled' && <p role="status">Local AI analysis is disabled. It can be enabled explicitly in local server configuration.</p>}
                {analysis.caseId === item.id && analysis.kind === 'unauthenticated' && <p role="alert">Your session is no longer authorized. Sign in again to continue.</p>}
                {analysis.caseId === item.id && analysis.kind === 'forbidden' && <p role="alert">Analysis was denied because the required case permission or membership is unavailable.</p>}
                {analysis.caseId === item.id && analysis.kind === 'failed' && <p role="alert">Analysis could not be completed. Check the local provider and retry.</p>}
                {analysis.caseId === item.id && analysis.kind === 'success' && analysis.result && <section className="analysis-result" aria-labelledby={`analysis-${item.id}`}>
                  <h4 id={`analysis-${item.id}`}>AI-assisted analysis</h4>
                  <dl>
                    <div><dt>Category</dt><dd>{analysis.result.category}</dd></div>
                    <div><dt>Priority</dt><dd>{analysis.result.priority}</dd></div>
                    <div><dt>Recommended team</dt><dd>{analysis.result.recommendedTeam}</dd></div>
                    <div><dt>Rationale</dt><dd>{analysis.result.rationale}</dd></div>
                    <div><dt>Suggested next action</dt><dd>{analysis.result.nextAction}</dd></div>
                    <div><dt>Model-reported confidence (uncalibrated) / uncertainty</dt><dd>{Math.round(analysis.result.confidence * 100)}% · {analysis.result.uncertainty}</dd></div>
                    <div><dt>Case-field evidence references</dt><dd>{analysis.result.evidenceReferences.join(', ')}</dd></div>
                    <div><dt>Execution</dt><dd>{analysis.result.execution.provider} · {analysis.result.execution.model} · {analysis.result.metrics.latencyMs} ms
                      {analysis.result.metrics.promptTokens === null ? '' : ` · ${analysis.result.metrics.promptTokens} input tokens`}
                      {analysis.result.metrics.generatedTokens === null ? '' : ` · ${analysis.result.metrics.generatedTokens} output tokens`}</dd></div>
                  </dl>
                  <p>{analysis.result.disclaimer}</p>
                  <p className="analysis-warning">Human review is required. No recommendation is executed and no case is changed.</p>
                </section>}
                {grounded.caseId === item.id && grounded.kind === 'loading' && <p role="status">Searching authorized synthetic documents and preparing a grounded analysis…</p>}
                {grounded.caseId === item.id && grounded.kind === 'disabled' && <p role="status">Grounded local analysis is disabled for this development server.</p>}
                {grounded.caseId === item.id && grounded.kind === 'unauthenticated' && <p role="alert">Your session is no longer authorized. Sign in again to continue.</p>}
                {grounded.caseId === item.id && grounded.kind === 'forbidden' && <p role="alert">Grounded analysis was denied because the required case permission or tenant membership is unavailable.</p>}
                {grounded.caseId === item.id && grounded.kind === 'validationFailed' && <p role="alert">Grounded analysis output did not pass the required validation contract. No recommendation was returned.</p>}
                {grounded.caseId === item.id && grounded.kind === 'providerUnavailable' && <p role="alert">The local grounded analysis provider is unavailable. No recommendation was returned.</p>}
                {grounded.caseId === item.id && grounded.kind === 'failed' && <p role="alert">Grounded analysis could not be completed. Check the local provider and retry.</p>}
                {grounded.caseId === item.id && grounded.kind === 'insufficient' && <section className="analysis-result" aria-labelledby={`grounded-${item.id}`}>
                  <h4 id={`grounded-${item.id}`}>Insufficient evidence</h4>
                  <p>{grounded.result?.groundingState === 'INSUFFICIENT_EVIDENCE' ? grounded.result.message : 'Available synthetic documents did not provide sufficient evidence.'}</p>
                  <p className="analysis-warning">Human review is required. No recommendation was executed and the case was not changed.</p>
                </section>}
                {grounded.caseId === item.id && grounded.kind === 'success' && grounded.result?.groundingState === 'SUPPORTED' && <section className="analysis-result" aria-labelledby={`grounded-${item.id}`}>
                  <h4 id={`grounded-${item.id}`}>Grounded AI-assisted analysis</h4>
                  <dl>
                    <div><dt>Category</dt><dd>{grounded.result.category}</dd></div>
                    <div><dt>Priority</dt><dd>{grounded.result.priority}</dd></div>
                    <div><dt>Recommended team</dt><dd>{grounded.result.recommendedTeam}</dd></div>
                    <div><dt>Rationale</dt><dd>{grounded.result.rationale}</dd></div>
                    <div><dt>Suggested next action</dt><dd>{grounded.result.nextAction}</dd></div>
                    <div><dt>Model-reported confidence (uncalibrated) / uncertainty</dt><dd>{Math.round(grounded.result.confidence * 100)}% · {grounded.result.uncertainty}</dd></div>
                    <div><dt>Retrieved sources</dt><dd><ul>{grounded.result.citations.map((citation) => <li key={citation.citationId}>
                      {citation.title} · {citation.sourceIdentity} · version {citation.version}: {citation.excerpt}</li>)}</ul></dd></div>
                    <div><dt>Execution</dt><dd>{grounded.result.execution.provider} · {grounded.result.execution.model} · {grounded.result.metrics.latencyMs} ms</dd></div>
                  </dl>
                  <p>{grounded.result.disclaimer}</p>
                  <p className="analysis-warning">Human review is required. No recommendation is executed and no case is changed.</p>
                </section>}
              </li>)}
            </ul>}
          </div>}
          {view.kind === 'unauthenticated' && <div role="alert"><p>Your session is no longer authorized. Sign in again to continue.</p><button className="auth-button secondary" onClick={() => void signIn()}>Sign in again</button></div>}
          {view.kind === 'forbidden' && <p role="alert">Access was denied. Your account may not have the required permission or tenant membership.</p>}
          {view.kind === 'unavailable' && <p role="alert">{view.message ?? 'Case data is unavailable. Check the local API and retry.'}</p>}
        </div>
      )}
      <p className="auth-disclaimer">Development-only protected case access. Human reviews record decisions only; case status and recommended actions are not changed.</p>
    </section>
  );
}

export default function DevAuthExperience({ config }: { config: AuthConfig }) {
  if (!isApprovedLoopbackOrigin(window.location.origin)) {
    return <section className="auth-cases wrap" id="secure-cases" role="alert">
      <h2>Sign-in is disabled on this origin</h2><p>Use the approved local address http://127.0.0.1:5173.</p>
    </section>;
  }
  const redirectUri = 'http://127.0.0.1:5173/';
  return <Auth0Provider domain={config.domain} clientId={config.clientId} cacheLocation="memory" useRefreshTokens={false}
      authorizationParams={{ redirect_uri: redirectUri, audience: config.audience, scope: 'read:cases write:cases' }}>
    <CaseAccessPanel />
  </Auth0Provider>;
}
