import { useEffect, useRef, useState } from 'react';
import { Auth0Provider, useAuth0 } from '@auth0/auth0-react';
import type { AuthConfig } from './config';
import { isApprovedLoopbackOrigin } from './config';
import { isAnalysisResult, type AnalysisResult } from '../../../api/src/ai/analysis.js';

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

type ViewState = { kind: 'idle' | 'loading' | 'ready' | 'unauthenticated' | 'forbidden' | 'unavailable'; cases: StoredCase[]; message?: string };
type AnalysisState = { kind: 'idle' | 'loading' | 'disabled' | 'success' | 'unauthenticated' | 'forbidden' | 'failed'; caseId?: string; result?: AnalysisResult };

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
  const requestGeneration = useRef(0);
  const analysisGeneration = useRef(0);
  const analysisController = useRef<AbortController | undefined>(undefined);
  const selectedTenant = tenants.find((tenant) => tenant.id === tenantId) ?? tenants[0];

  useEffect(() => {
    const generation = ++requestGeneration.current;
    analysisGeneration.current++;
    analysisController.current?.abort();
    analysisController.current = undefined;
    setAnalysis({ kind: 'idle' });
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
        setView({ kind: 'ready', cases: body });
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
    };
  }, [getAccessTokenSilently, isAuthenticated, tenantId, user?.sub]);

  function changeTenant(nextTenant: string) {
    requestGeneration.current += 1;
    analysisGeneration.current += 1;
    analysisController.current?.abort();
    analysisController.current = undefined;
    setAnalysis({ kind: 'idle' });
    setView({ kind: 'idle', cases: [] });
    setTenantId(nextTenant);
  }

  async function analyzeCase(caseId: string) {
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

  async function signOut() {
    requestGeneration.current += 1;
    analysisGeneration.current += 1;
    analysisController.current?.abort();
    analysisController.current = undefined;
    setAnalysis({ kind: 'idle' });
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
        <div className="auth-card"><p>Sign in to request read-only access to synthetic cases. The API checks your identity, scope, tenant membership and row-level policy.</p>
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
                <button type="button" className="auth-button secondary" disabled={analysis.kind === 'loading'}
                  onClick={() => void analyzeCase(item.id)}>Analyze with local AI</button>
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
              </li>)}
            </ul>}
          </div>}
          {view.kind === 'unauthenticated' && <div role="alert"><p>Your session is no longer authorized. Sign in again to continue.</p><button className="auth-button secondary" onClick={() => void signIn()}>Sign in again</button></div>}
          {view.kind === 'forbidden' && <p role="alert">Access was denied. Your account may not have the required permission or tenant membership.</p>}
          {view.kind === 'unavailable' && <p role="alert">{view.message ?? 'Case data is unavailable. Check the local API and retry.'}</p>}
        </div>
      )}
      <p className="auth-disclaimer">Development-only, read-only access. No case changes are available here.</p>
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
    authorizationParams={{ redirect_uri: redirectUri, audience: config.audience, scope: 'read:cases' }}>
    <CaseAccessPanel />
  </Auth0Provider>;
}
