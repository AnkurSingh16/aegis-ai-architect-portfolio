import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import InvestigationPanel, { isTerminalStage, stageLabel } from './InvestigationPanel';

const sessionMock = vi.hoisted(() => ({
  status: 'anonymous' as 'anonymous' | 'authenticated',
  signIn: vi.fn(),
  getAccessToken: vi.fn(),
}));

vi.mock('./session', () => ({
  useSession: () => sessionMock,
}));

const NORTH = '10000000-0000-4000-8000-000000000001';
const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
  sessionMock.status = 'anonymous';
});

describe('investigation panel', () => {
  it('offers sign-in inside its own section without calling the API', () => {
    globalThis.fetch = vi.fn();
    render(<InvestigationPanel />);
    const section = screen.getByRole('region', { name: 'Evidence-backed investigation' });
    fireEvent.click(within(section).getByRole('button', { name: 'Sign in' }));
    expect(sessionMock.signIn).toHaveBeenCalledOnce();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rejects an empty question locally without calling the API', () => {
    sessionMock.status = 'authenticated';
    sessionMock.getAccessToken.mockResolvedValue('synthetic-token');
    globalThis.fetch = vi.fn();
    render(<InvestigationPanel />);
    fireEvent.submit(screen.getByRole('region', { name: 'Evidence-backed investigation' }).querySelector('form') as HTMLFormElement);
    expect(screen.getByRole('alert').textContent).toMatch(/1 to 1000 characters/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('submits through the authenticated API with a bearer token and an idempotency key', async () => {
    sessionMock.status = 'authenticated';
    sessionMock.getAccessToken.mockResolvedValue('synthetic-token');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202, json: async () => ({ executionId: 'exec-1' }) });
    globalThis.fetch = fetchMock;
    render(<InvestigationPanel />);
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: '  What is the synthetic login guidance?  ' } });
    fireEvent.click(screen.getByRole('button', { name: /investigate|submit/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(`/api/tenants/${NORTH}/investigations`);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer synthetic-token');
    expect(headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(init.body as string)).toEqual({ question: 'What is the synthetic login guidance?' });
    expect(document.body.textContent).not.toContain('synthetic-token');
  });

  it('shows a generic message for a refused tenant without exposing response details', async () => {
    sessionMock.status = 'authenticated';
    sessionMock.getAccessToken.mockResolvedValue('synthetic-token');
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ detail: 'internal policy 42' }) });
    render(<InvestigationPanel />);
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Synthetic question?' } });
    fireEvent.click(screen.getByRole('button', { name: /investigate|submit/i }));
    expect(await screen.findByText(/not authorised to investigate for this tenant/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('internal policy 42');
  });
});

describe('investigation stage helpers', () => {
  it('treats only final stages as terminal', () => {
    expect(isTerminalStage('completed')).toBe(true);
    expect(isTerminalStage('insufficient_evidence')).toBe(true);
    expect(isTerminalStage('review_received')).toBe(false);
  });

  it('labels known stages and falls back for unknown ones', () => {
    expect(stageLabel('retrieval_requested')).toBe('Retrieving evidence');
    expect(stageLabel('something_new')).toBe('Processing');
  });
});
