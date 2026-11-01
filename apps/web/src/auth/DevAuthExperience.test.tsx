import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import DevAuthExperience from './DevAuthExperience';

const authMocks = vi.hoisted(() => ({
  state: { isAuthenticated: false, isLoading: false, error: undefined as Error | undefined } as {
    isAuthenticated: boolean; isLoading: boolean; error?: Error;
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

  it('does not surface token acquisition or redirect errors', async () => {
    authMocks.state = { isAuthenticated: false, isLoading: false };
    authMocks.loginWithRedirect.mockRejectedValue(new Error('token secret detail'));
    render(<DevAuthExperience config={config} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Auth0' }));
    expect(await screen.findByText(/Sign-in could not be started/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('token secret detail');
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
