import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import App from './App';

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

describe('portfolio homepage', () => {
  it('renders architectural case studies and reports a healthy API', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, service: 'aegis-api' }) });
    render(<App />);
    expect(screen.getByRole('heading', { name: /AI systems that deserve/i })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Aegis AI/i })).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Local API connected')).toBeTruthy());
  });
  it('does not falsely report success when the API is unreachable', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline'));
    render(<App />);
    await waitFor(() => expect(screen.getByText(/API offline/i)).toBeTruthy());
  });
});
