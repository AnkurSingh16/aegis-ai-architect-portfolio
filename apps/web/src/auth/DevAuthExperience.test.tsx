import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import DevAuthExperience from './DevAuthExperience';

const authMocks = vi.hoisted(() => ({
  state: { isAuthenticated: false, isLoading: false, error: undefined as Error | undefined } as {
    isAuthenticated: boolean; isLoading: boolean; error?: Error; user?: { sub: string };
  },
  loginWithRedirect: vi.fn(),
  logout: vi.fn(),
  getAccessTokenSilently: vi.fn(),
  providerProps: undefined as Record<string, unknown> | undefined,
}));

vi.mock('@auth0/auth0-react', () => ({
  Auth0Provider: (props: Record<string, unknown>) => {
    authMocks.providerProps = props;
    return props.children;
  },
  useAuth0: () => ({ ...authMocks.state, loginWithRedirect: authMocks.loginWithRedirect,
    logout: authMocks.logout, getAccessTokenSilently: authMocks.getAccessTokenSilently }),
}));

const config = { domain: 'dev-tzvthmve8npi2dw7.au.auth0.com', clientId: 'public-client-id', audience: 'https://aegis-ai.local/api' };
const northCase = { id: 'case-1', tenant_id: '10000000-0000-4000-8000-000000000001',
  synthetic_case_id: 'SYN-NORTH-001', status: 'open', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };
const analysis = { caseId: 'case-1', category: 'incident', priority: 'high', recommendedTeam: 'Platform support',
  rationale: 'The stored synthetic case fields indicate a possible sign-in interruption.',
  nextAction: 'Review the synthetic service impact and incident timeline.', confidence: 0.72, uncertainty: 'moderate',
  evidenceReferences: ['synthetic_case_id', 'status'], humanReviewRequired: true,
  execution: { provider: 'ollama', model: 'fixture-model:1b', mode: 'local-model' },
  metrics: { latencyMs: 25, promptTokens: 20, generatedTokens: 30 },
  disclaimer: 'Advisory analysis only. Evidence references identify case fields; they are not RAG citations or external source grounding.' };
const groundedAnalysis = { groundingState: 'SUPPORTED', caseId: 'case-1', category: 'incident', priority: 'medium',
  recommendedTeam: 'Platform support', rationale: 'The synthetic guide supports a human review of the reported sign-in issue.',
  nextAction: 'Review the synthetic service impact and incident timeline.',
  citations: [{ citationId: '12345678-1234-4234-8234-123456789abc', sourceIdentity: 'SYNTHETIC-NORTH-LOGIN', version: 1,
    title: 'Synthetic login guide', excerpt: 'A human support agent verifies the sign-in impact.' }],
  confidence: 0.62, uncertainty: 'moderate', humanReviewRequired: true,
  execution: { provider: 'ollama', model: 'mock-local-model', mode: 'local-model' },
  metrics: { latencyMs: 25, promptTokens: 20, generatedTokens: 30 },
  disclaimer: 'Advisory only. Citations identify retrieved synthetic source chunks; they do not prove that a claim is entailed by a source.' };
const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
  authMocks.state = { isAuthenticated: false, isLoading: false, error: undefined };
  window.history.replaceState({}, '', '/');
});

describe('development Auth0 case experience', () => {
  it('configures memory-only Authorization Code + PKCE SDK settings and pinned callback', () => {
    authMocks.state = { isAuthenticated: true, isLoading: false };
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [] });
    render(<DevAuthExperience config={config} />);
    expect(authMocks.providerProps).toMatchObject({ domain: config.domain, clientId: config.clientId,
      cacheLocation: 'memory', useRefreshTokens: false,
      authorizationParams: { redirect_uri: 'http://127.0.0.1:5173/', audience: config.audience, scope: 'read:cases' } });
  });

  it('offers sign-in without calling the API when unauthenticated', () => {
    globalThis.fetch = vi.fn();
    render(<DevAuthExperience config={config} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Auth0' }));
    expect(authMocks.loginWithRedirect).toHaveBeenCalledOnce();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('shows callback progress while the SDK processes the authorization response', () => {
    authMocks.state = { isAuthenticated: false, isLoading: true };
    window.history.replaceState({}, '', '/?code=synthetic-code&state=synthetic-state');
    globalThis.fetch = vi.fn();
    render(<DevAuthExperience config={config} />);
    expect(screen.getByRole('status').textContent).toContain('Completing secure sign-in');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('shows callback completion while the SDK processes the returned authorization response', () => {
    authMocks.state = { isAuthenticated: false, isLoading: true };
    window.history.replaceState({}, '', '/?code=synthetic-code&state=synthetic-state');
    render(<DevAuthExperience config={config} />);
    expect(screen.getByRole('status').textContent).toMatch(/Completing secure sign-in/);
    expect(document.body.textContent).not.toContain('synthetic-code');
  });

  it('shows a generic callback failure without exposing SDK error details', () => {
    authMocks.state = { isAuthenticated: false, isLoading: false, error: new Error('private callback code detail') };
    window.history.replaceState({}, '', '/?code=private-code&state=state-value');
    render(<DevAuthExperience config={config} />);
    expect(screen.getByRole('alert').textContent).toMatch(/Auth0 sign-in could not be completed/);
    expect(document.body.textContent).not.toContain('private callback code detail');
    expect(document.body.textContent).not.toContain('private-code');
  });

  it('fetches and renders only cases matching the selected tenant', async () => {
    authMocks.state = { isAuthenticated: true, isLoading: false };
    authMocks.getAccessTokenSilently.mockResolvedValue('private-test-token');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [northCase] });
    globalThis.fetch = fetchMock;
    render(<DevAuthExperience config={config} />);
    expect(await screen.findByText('SYN-NORTH-001')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith('/api/tenants/10000000-0000-4000-8000-000000000001/cases', expect.objectContaining({
      method: 'GET', credentials: 'omit', redirect: 'error', headers: { Authorization: 'Bearer private-test-token', Accept: 'application/json' },
    }));
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.body.textContent).not.toContain('private-test-token');
    fireEvent.change(screen.getByLabelText('Requested tenant'), { target: { value: '20000000-0000-4000-8000-000000000002' } });
    await waitFor(() => expect(screen.queryByText('SYN-NORTH-001')).toBeNull());
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(fetchMock).toHaveBeenLastCalledWith('/api/tenants/20000000-0000-4000-8000-000000000002/cases', expect.anything());
  });

  it('does not render a delayed response after the requested tenant changes', async () => {
    authMocks.state = { isAuthenticated: true, isLoading: false };
    authMocks.getAccessTokenSilently.mockResolvedValue('private-test-token');
    let finishNorth!: (response: { ok: boolean; status: number; json: () => Promise<unknown> }) => void;
    const northResponse = new Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>((resolve) => { finishNorth = resolve; });
    const fetchMock = vi.fn()
      .mockReturnValueOnce(northResponse)
      .mockResolvedValueOnce({ ok: false, status: 403 });
    globalThis.fetch = fetchMock;
    const { container } = render(<DevAuthExperience config={config} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText('Requested tenant'), { target: { value: '20000000-0000-4000-8000-000000000002' } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    finishNorth({ ok: true, status: 200, json: async () => [northCase] });

    await screen.findByText(/Access was denied/);
    expect(container.textContent).not.toContain('SYN-NORTH-001');
  });

  it('does not render North JSON that resolves after the user selects South', async () => {
    authMocks.state = { isAuthenticated: true, isLoading: false };
    authMocks.getAccessTokenSilently.mockResolvedValue('private-test-token');
    let resolveNorthBody!: (body: unknown) => void;
    const northBody = new Promise<unknown>((resolve) => { resolveNorthBody = resolve; });
    const northJson = vi.fn(() => northBody);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: northJson })
      .mockResolvedValueOnce({ ok: false, status: 403 });
    globalThis.fetch = fetchMock;
    const { container } = render(<DevAuthExperience config={config} />);

    await waitFor(() => expect(northJson).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByLabelText('Requested tenant'), { target: { value: '20000000-0000-4000-8000-000000000002' } });
    await screen.findByText(/Access was denied/);
    await act(async () => { resolveNorthBody([northCase]); await northBody; });

    expect(container.textContent).not.toContain('SYN-NORTH-001');
    expect(container.textContent).toContain('Access was denied');
  });

  it('invalidates a response when the authenticated identity changes', async () => {
    authMocks.state = { isAuthenticated: true, isLoading: false, user: { sub: 'auth0|reader-a' } };
    authMocks.getAccessTokenSilently.mockResolvedValue('private-test-token');
    let resolveBody!: (body: unknown) => void;
    const body = new Promise<unknown>((resolve) => { resolveBody = resolve; });
    const json = vi.fn(() => body);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json })
      .mockResolvedValueOnce({ ok: false, status: 403 });
    globalThis.fetch = fetchMock;
    const { container, rerender } = render(<DevAuthExperience config={config} />);

    await waitFor(() => expect(json).toHaveBeenCalledOnce());
    authMocks.state = { isAuthenticated: true, isLoading: false, user: { sub: 'auth0|reader-b' } };
    rerender(<DevAuthExperience config={config} />);
    await screen.findByText(/Access was denied/);
    await act(async () => { resolveBody([northCase]); await body; });

    expect(container.textContent).not.toContain('SYN-NORTH-001');
  });

  it('does not update the view when response parsing finishes after unmount', async () => {
    authMocks.state = { isAuthenticated: true, isLoading: false };
    authMocks.getAccessTokenSilently.mockResolvedValue('private-test-token');
    let resolveBody!: (body: unknown) => void;
    const body = new Promise<unknown>((resolve) => { resolveBody = resolve; });
    const json = vi.fn(() => body);
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { unmount } = render(<DevAuthExperience config={config} />);

    await waitFor(() => expect(json).toHaveBeenCalledOnce());
    unmount();
    await act(async () => { resolveBody([northCase]); await body; });

    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('handles 401, 403 and API outage with generic messages and no token disclosure', async () => {
    authMocks.state = { isAuthenticated: true, isLoading: false };
    authMocks.getAccessTokenSilently.mockResolvedValue('private-test-token');
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    const { rerender } = render(<DevAuthExperience config={config} />);
    expect(await screen.findByText(/Access was denied/)).toBeTruthy();
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 401 });
    fireEvent.change(screen.getByLabelText('Requested tenant'), { target: { value: '20000000-0000-4000-8000-000000000002' } });
    expect(await screen.findByText(/session is no longer authorized/)).toBeTruthy();
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('private-test-token network detail'));
    fireEvent.change(screen.getByLabelText('Requested tenant'), { target: { value: '10000000-0000-4000-8000-000000000001' } });
    expect(await screen.findByText(/Case data is unavailable/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('private-test-token');
    rerender(<DevAuthExperience config={config} />);
  });

  it('clears data and signs out through the pinned local return URL', async () => {
    authMocks.state = { isAuthenticated: true, isLoading: false };
    authMocks.getAccessTokenSilently.mockResolvedValue('private-test-token');
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [northCase] });
    render(<DevAuthExperience config={config} />);
    expect(await screen.findByText('SYN-NORTH-001')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(authMocks.logout).toHaveBeenCalledWith({ logoutParams: { returnTo: 'http://127.0.0.1:5173' } }));
  });

  it('rejects a response containing a foreign tenant record', async () => {
    authMocks.state = { isAuthenticated: true, isLoading: false };
    authMocks.getAccessTokenSilently.mockResolvedValue('private-test-token');
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [{ ...northCase, tenant_id: '20000000-0000-4000-8000-000000000002' }] });
    render(<DevAuthExperience config={config} />);
    expect(await screen.findByText(/Case data is unavailable/)).toBeTruthy();
    expect(screen.queryByText('SYN-NORTH-001')).toBeNull();
  });

  it('does not persist tokens in browser storage', async () => {
    authMocks.state = { isAuthenticated: true, isLoading: false };
    authMocks.getAccessTokenSilently.mockResolvedValue('private-test-token');
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [northCase] });
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
    render(<DevAuthExperience config={config} />);
    expect(await screen.findByText('SYN-NORTH-001')).toBeTruthy();
    expect(storageWrite).not.toHaveBeenCalled();
  });

  it('analyzes only a displayed authorized case and renders review metadata without sending case text', async () => {
    authMocks.state = { isAuthenticated: true, isLoading: false };
    authMocks.getAccessTokenSilently.mockResolvedValue('private-test-token');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [northCase] })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => analysis });
    globalThis.fetch = fetchMock;
    render(<DevAuthExperience config={config} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Analyze with local AI' }));
    expect(await screen.findByText(/possible sign-in interruption/)).toBeTruthy();
    expect(screen.getByText(/Human review is required/)).toBeTruthy();
    expect(screen.getByText(/not RAG citations or external source grounding/)).toBeTruthy();
    expect(screen.getByText(/Model-reported confidence \(uncalibrated\)/)).toBeTruthy();
    expect(screen.getByText(/20 input tokens/)).toBeTruthy();
    expect(fetchMock).toHaveBeenLastCalledWith('/api/tenants/10000000-0000-4000-8000-000000000001/cases/case-1/ai-analysis',
      expect.objectContaining({ method: 'POST', credentials: 'omit', redirect: 'error',
        headers: { Authorization: 'Bearer private-test-token', Accept: 'application/json' }, signal: expect.any(AbortSignal) }));
    expect(fetchMock.mock.calls[1][1]).not.toHaveProperty('body');
  });

  it('distinguishes disabled local inference and provider failure without fabricating results', async () => {
    authMocks.state = { isAuthenticated: true, isLoading: false };
    authMocks.getAccessTokenSilently.mockResolvedValue('private-test-token');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [northCase] })
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ code: 'ai_analysis_disabled' }) })
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ code: 'ai_analysis_unavailable' }) });
    globalThis.fetch = fetchMock;
    render(<DevAuthExperience config={config} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Analyze with local AI' }));
    expect(await screen.findByText(/Local AI analysis is disabled/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Analyze with local AI' }));
    expect(await screen.findByText(/Analysis could not be completed/)).toBeTruthy();
    expect(screen.queryByText(/possible sign-in interruption/)).toBeNull();
  });

  it('cancels stale analysis on tenant change and clears analysis on logout', async () => {
    authMocks.state = { isAuthenticated: true, isLoading: false };
    authMocks.getAccessTokenSilently.mockResolvedValue('private-test-token');
    let resolveAnalysis!: (body: unknown) => void;
    const delayed = new Promise<unknown>((resolve) => { resolveAnalysis = resolve; });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [northCase] })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => delayed })
      .mockResolvedValueOnce({ ok: false, status: 403 });
    globalThis.fetch = fetchMock;
    const { container } = render(<DevAuthExperience config={config} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Analyze with local AI' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByLabelText('Requested tenant'), { target: { value: '20000000-0000-4000-8000-000000000002' } });
    await act(async () => { resolveAnalysis(analysis); await delayed; });
    expect(container.textContent).not.toContain('possible sign-in interruption');
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(container.textContent).not.toContain('possible sign-in interruption');
    expect(fetchMock.mock.calls[1][1].signal.aborted).toBe(true);
  });

  it('clears successful analysis on sign-out and never persists its bearer token', async () => {
    authMocks.state = { isAuthenticated: true, isLoading: false };
    authMocks.getAccessTokenSilently.mockResolvedValue('private-test-token');
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [northCase] })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => analysis });
    render(<DevAuthExperience config={config} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Analyze with local AI' }));
    expect(await screen.findByText(/possible sign-in interruption/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(screen.queryByText(/possible sign-in interruption/)).toBeNull();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.body.textContent).not.toContain('private-test-token');
  });

  it('aborts and discards analysis when the authenticated identity changes during response parsing', async () => {
    authMocks.state = { isAuthenticated: true, isLoading: false, user: { sub: 'auth0|reader-a' } };
    authMocks.getAccessTokenSilently.mockResolvedValue('private-test-token');
    let resolveBody!: (value: unknown) => void;
    const delayedBody = new Promise<unknown>((resolve) => { resolveBody = resolve; });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [northCase] })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => delayedBody })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [northCase] });
    globalThis.fetch = fetchMock;
    const { container, rerender } = render(<DevAuthExperience config={config} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Analyze with local AI' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    authMocks.state = { isAuthenticated: true, isLoading: false, user: { sub: 'auth0|reader-b' } };
    rerender(<DevAuthExperience config={config} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await act(async () => { resolveBody(analysis); await delayedBody; });
    expect(fetchMock.mock.calls[1][1].signal.aborted).toBe(true);
    expect(container.textContent).not.toContain('possible sign-in interruption');
    expect(container.textContent).toContain('SYN-NORTH-001');
  });

  it('does not surface token acquisition or redirect errors', async () => {
    authMocks.state = { isAuthenticated: false, isLoading: false };
    authMocks.loginWithRedirect.mockRejectedValue(new Error('token secret detail'));
    render(<DevAuthExperience config={config} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Auth0' }));
    expect(await screen.findByText(/Sign-in could not be started/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('token secret detail');
  });

  it('requests grounded analysis only for a loaded authorized case and renders validated citations', async () => {
    authMocks.state = { isAuthenticated: true, isLoading: false };
    authMocks.getAccessTokenSilently.mockResolvedValue('private-test-token');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [northCase] })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => groundedAnalysis });
    globalThis.fetch = fetchMock;
    render(<DevAuthExperience config={config} />);
    expect(await screen.findByText('SYN-NORTH-001')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Analyze with grounded documents' }));
    expect(await screen.findByText('Grounded AI-assisted analysis')).toBeTruthy();
    expect(screen.getByText(/SYNTHETIC-NORTH-LOGIN/)).toBeTruthy();
    expect(screen.getByText(/Model-reported confidence \(uncalibrated\)/)).toBeTruthy();
    expect(screen.getByText(/do not prove that a claim is entailed/)).toBeTruthy();
    expect(fetchMock).toHaveBeenLastCalledWith('/api/tenants/10000000-0000-4000-8000-000000000001/cases/case-1/grounded-analysis',
      expect.objectContaining({ method: 'POST', credentials: 'omit', redirect: 'error',
        headers: { Authorization: 'Bearer private-test-token', Accept: 'application/json' } }));
    expect(fetchMock.mock.calls[1][1]).not.toHaveProperty('body');
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.body.textContent).not.toContain('private-test-token');
  });

  it('shows explicit insufficient-evidence state and clears it when tenant changes', async () => {
    authMocks.state = { isAuthenticated: true, isLoading: false };
    authMocks.getAccessTokenSilently.mockResolvedValue('private-test-token');
    const empty = { groundingState: 'INSUFFICIENT_EVIDENCE', caseId: 'case-1', citations: [], humanReviewRequired: true,
      message: 'Available synthetic documents did not provide sufficient evidence.' };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [northCase] })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => empty })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [] });
    globalThis.fetch = fetchMock;
    render(<DevAuthExperience config={config} />);
    expect(await screen.findByText('SYN-NORTH-001')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Analyze with grounded documents' }));
    expect(await screen.findByText('Insufficient evidence')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Requested tenant'), { target: { value: '20000000-0000-4000-8000-000000000002' } });
    await waitFor(() => expect(screen.queryByText('Insufficient evidence')).toBeNull());
  });

  it('distinguishes validation failure from local provider unavailability using fixed safe codes', async () => {
    authMocks.state = { isAuthenticated: true, isLoading: false };
    authMocks.getAccessTokenSilently.mockResolvedValue('private-test-token');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [northCase] })
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ code: 'grounded_analysis_validation_failed' }) })
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ code: 'grounded_analysis_provider_unavailable' }) });
    globalThis.fetch = fetchMock;
    render(<DevAuthExperience config={config} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Analyze with grounded documents' }));
    expect(await screen.findByText(/did not pass the required validation contract/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Analyze with grounded documents' }));
    expect(await screen.findByText(/local grounded analysis provider is unavailable/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('failureStage');
    expect(document.body.textContent).not.toContain('schemaReason');
  });

  it('offers recovery after token acquisition fails without showing provider details', async () => {
    authMocks.state = { isAuthenticated: true, isLoading: false };
    authMocks.getAccessTokenSilently.mockRejectedValue(new Error('private provider detail'));
    globalThis.fetch = vi.fn();
    render(<DevAuthExperience config={config} />);
    expect(await screen.findByText(/Your session is no longer authorized/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in again' })).toBeTruthy();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('private provider detail');
  });
});
