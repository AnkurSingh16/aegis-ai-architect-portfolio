import { useEffect, useRef, useState, type FormEvent } from 'react';
import { isTriageResult, syntheticCases, type SyntheticCaseId, type TriageResult } from '../../api/src/contracts/triage.js';

export const TRIAGE_TIMEOUT_MS = 10_000;
type PendingRequest = { controller: AbortController; timer: ReturnType<typeof setTimeout> };

export default function Triage() {
  const [caseId, setCaseId] = useState<SyntheticCaseId>(syntheticCases[0].id);
  const [result, setResult] = useState<TriageResult | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const requestRef = useRef<PendingRequest | null>(null);
  const selectedCase = syntheticCases.find((item) => item.id === caseId)!;

  useEffect(() => () => {
    const request = requestRef.current;
    requestRef.current = null;
    if (request) {
      clearTimeout(request.timer);
      request.controller.abort();
    }
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (requestRef.current) return;
    setResult(null);
    setError('');
    setPending(true);
    const request: PendingRequest = {
      controller: new AbortController(),
      timer: setTimeout(() => {
        if (requestRef.current !== request) return;
        requestRef.current = null;
        request.controller.abort();
        setPending(false);
        setError('Triage timed out. Please retry.');
      }, TRIAGE_TIMEOUT_MS),
    };
    requestRef.current = request;
    try {
      const response = await fetch('/api/demo/triage', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseId }), signal: request.controller.signal,
      });
      if (!response.ok) throw new Error('Triage request failed');
      const data: unknown = await response.json();
      if (!isTriageResult(data, caseId)) throw new Error('Invalid triage response');
      if (requestRef.current === request) setResult(data);
    } catch {
      if (requestRef.current === request) setError('Unable to triage this synthetic case. Check the local API and retry.');
    } finally {
      clearTimeout(request.timer);
      if (requestRef.current === request) {
        requestRef.current = null;
        setPending(false);
      }
    }
  }

  return (
    <section id="triage" className="triage wrap" aria-labelledby="triage-heading">
      <p className="eyebrow">LOCAL WORKFLOW · SYNTHETIC MOCK</p>
      <h2 id="triage-heading">Customer support case triage</h2>
      <p id="triage-description">Explore three invented cases with fixed mock recommendations. No real AI, customer data or actions.</p>
      {import.meta.env.PROD ? <p role="status">This demonstration is available locally with npm run dev. The production API does not expose triage.</p> : <>
        <form onSubmit={submit} aria-describedby="triage-description">
          <label htmlFor="synthetic-case">Synthetic support case</label>
          <select id="synthetic-case" value={caseId} disabled={pending} onChange={(event) => {
            const selected = syntheticCases.find((item) => item.id === event.target.value);
            if (selected) { setCaseId(selected.id); setResult(null); setError(''); }
          }} aria-describedby="selected-case-description">
            {syntheticCases.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
          </select>
          <p id="selected-case-description">{selectedCase.description}</p>
          <button className="primary" type="submit" disabled={pending}>{pending ? 'Triaging…' : 'Triage synthetic case'}</button>
        </form>
        <p role="status" aria-live="polite">{pending ? 'Triaging the synthetic case…' : result ? 'Synthetic triage complete.' : 'Choose a case to see a mock recommendation.'}</p>
        {error && <p role="alert" className="triage-error">{error}</p>}
        {result && <section className="triage-result" aria-labelledby="triage-result-heading">
          <h3 id="triage-result-heading">Mock triage: {selectedCase.title}</h3>
          <dl>
            <div><dt>Category</dt><dd>{result.category}</dd></div>
            <div><dt>Priority</dt><dd>{result.priority}</dd></div>
            <div><dt>Suggested team</dt><dd>{result.suggestedTeam}</dd></div>
            <div><dt>Rationale</dt><dd>{result.rationale}</dd></div>
            <div><dt>Suggested next step</dt><dd>{result.nextStep}</dd></div>
          </dl>
          <p>{result.warning}</p>
        </section>}
      </>}
    </section>
  );
}
