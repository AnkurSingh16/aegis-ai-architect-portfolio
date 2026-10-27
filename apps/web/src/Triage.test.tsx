import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import Triage, { TRIAGE_TIMEOUT_MS } from './Triage';
import { syntheticCases, type SyntheticCaseId } from '../../api/src/contracts/triage.js';
import { triageCase } from '../../api/src/triage.js';

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const firstId = syntheticCases[0].id;
const successful = (caseId: SyntheticCaseId = firstId) => ({ ok: true, json: async () => triageCase(caseId) });
function submit() { fireEvent.click(screen.getByRole('button', { name: 'Triage synthetic case' })); }

describe('synthetic case triage component', () => {
  it.each(syntheticCases)('submits and renders the recommendation for $title', async ({ id, title }) => {
    const fetchMock = vi.fn().mockResolvedValue(successful(id));
    globalThis.fetch = fetchMock;
    render(<Triage />);
    fireEvent.change(screen.getByLabelText('Synthetic support case'), { target: { value: id } });
    submit();
    await screen.findByRole('heading', { name: `Mock triage: ${title}` });
    expect(fetchMock).toHaveBeenCalledWith('/api/demo/triage', expect.objectContaining({
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ caseId: id }), signal: expect.any(AbortSignal),
    }));
    const result = triageCase(id);
    for (const text of [result.category, result.priority, result.suggestedTeam, result.rationale, result.nextStep, result.warning]) {
      expect(screen.getByText(text)).toBeTruthy();
    }
    expect(screen.getByRole('status').textContent).toBe('Synthetic triage complete.');
  });

  it('disables duplicate submission and selection while pending', async () => {
    let resolve!: (value: ReturnType<typeof successful>) => void;
    const fetchMock = vi.fn().mockReturnValue(new Promise((done) => { resolve = done; }));
    globalThis.fetch = fetchMock;
    render(<Triage />);
    submit();
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('Synthetic support case') as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByRole('status').textContent).toContain('Triaging');
    fireEvent.submit(screen.getByRole('button').closest('form')!);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => resolve(successful()));
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('clears the previous recommendation on selection change', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(successful());
    render(<Triage />);
    submit();
    await screen.findByRole('heading', { name: 'Mock triage: Login outage' });
    fireEvent.change(screen.getByLabelText('Synthetic support case'), { target: { value: syntheticCases[1].id } });
    expect(screen.queryByRole('heading', { name: /Mock triage:/ })).toBeNull();
    expect(screen.getByText(syntheticCases[1].description)).toBeTruthy();
  });

  it.each([
    ['network failure', () => Promise.reject(new Error('PRIVATE DETAIL'))],
    ['HTTP failure', () => Promise.resolve({ ok: false, json: async () => ({ error: 'PRIVATE DETAIL' }) })],
    ['malformed JSON', () => Promise.resolve({ ok: true, json: async () => { throw new SyntaxError('PRIVATE DETAIL'); } })],
    ['invalid shape', () => Promise.resolve({ ok: true, json: async () => ({ mode: 'real-ai' }) })],
    ['wrong case', () => Promise.resolve(successful(syntheticCases[1].id))],
  ])('handles %s with an accessible error and allows retry', async (_name, failure) => {
    const fetchMock = vi.fn().mockImplementationOnce(failure).mockResolvedValue(successful());
    globalThis.fetch = fetchMock;
    render(<Triage />);
    submit();
    expect((await screen.findByRole('alert')).textContent).toContain('Unable to triage this synthetic case');
    expect(screen.queryByText(/PRIVATE DETAIL/)).toBeNull();
    expect(screen.queryByRole('heading', { name: /Mock triage:/ })).toBeNull();
    submit();
    expect(screen.queryByRole('alert')).toBeNull();
    await screen.findByRole('heading', { name: 'Mock triage: Login outage' });
  });

  it('clears an error when a different case is selected', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline'));
    render(<Triage />);
    submit();
    await screen.findByRole('alert');
    fireEvent.change(screen.getByLabelText('Synthetic support case'), { target: { value: syntheticCases[2].id } });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('times out, aborts, ignores late results and permits a clean retry', async () => {
    vi.useFakeTimers();
    let resolve!: (value: ReturnType<typeof successful>) => void;
    const fetchMock = vi.fn().mockReturnValueOnce(new Promise((done) => { resolve = done; })).mockResolvedValue(successful());
    globalThis.fetch = fetchMock;
    render(<Triage />);
    submit();
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    await act(async () => { await vi.advanceTimersByTimeAsync(TRIAGE_TIMEOUT_MS); });
    expect(signal.aborted).toBe(true);
    expect(screen.getByRole('alert').textContent).toBe('Triage timed out. Please retry.');
    await act(async () => resolve(successful()));
    expect(screen.queryByRole('heading', { name: /Mock triage:/ })).toBeNull();
    await act(async () => submit());
    expect(screen.getByRole('heading', { name: 'Mock triage: Login outage' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('aborts on unmount and safely ignores a late rejection', async () => {
    let reject!: (reason: Error) => void;
    const fetchMock = vi.fn().mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
    globalThis.fetch = fetchMock;
    const { unmount } = render(<Triage />);
    submit();
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => reject(new Error('aborted')));
  });

  it('hides the interactive workflow in production and makes no request', async () => {
    vi.stubEnv('PROD', true);
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    render(<Triage />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('available locally');
    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled());
  });
});
