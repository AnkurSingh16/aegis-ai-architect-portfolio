import { describe, expect, it } from 'vitest';
import { assertApprovedConfidenceContractRuntime, confidenceContractReportExitCode,
  assertNoConfidenceContractProxy, safeConfidenceContractCliFailure } from './run-grounded-confidence-contract-local-evaluation.js';

describe('M4.17 confidence-contract evaluation CLI lifecycle', () => {
  it('returns success only when execution completed and strict contract acceptance passed', () => {
    expect(confidenceContractReportExitCode({ executionStatus: 'completed', contractAcceptanceStatus: 'passed' })).toBe(0);
    expect(confidenceContractReportExitCode({ executionStatus: 'completed', contractAcceptanceStatus: 'failed' })).toBe(1);
    expect(confidenceContractReportExitCode({ executionStatus: 'incomplete', contractAcceptanceStatus: 'passed' })).toBe(1);
  });

  it('exposes only fixed failure stages, never exception contents', () => {
    expect(safeConfidenceContractCliFailure('provider_evaluation')).toBe(
      '{"event":"grounded_confidence_contract_evaluation_cli_failure","failureStage":"provider_evaluation"}');
    expect(safeConfidenceContractCliFailure('secret model response')).toBe(
      '{"event":"grounded_confidence_contract_evaluation_cli_failure","failureStage":"unknown"}');
  });

  it('rejects any model, timeout, or concurrency outside the fixed local contract', () => {
    expect(() => assertApprovedConfidenceContractRuntime({ model: 'qwen2.5:3b-instruct', timeoutMs: 15000, maxConcurrent: 1 })).not.toThrow();
    expect(() => assertApprovedConfidenceContractRuntime({ model: 'remote-model', timeoutMs: 15000, maxConcurrent: 1 })).toThrow();
    expect(() => assertApprovedConfidenceContractRuntime({ model: 'qwen2.5:3b-instruct', timeoutMs: 15001, maxConcurrent: 1 })).toThrow();
    expect(() => assertApprovedConfidenceContractRuntime({ model: 'qwen2.5:3b-instruct', timeoutMs: 15000, maxConcurrent: 2 })).toThrow();
    expect(() => assertApprovedConfidenceContractRuntime(undefined)).toThrow();
  });

  it.each(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'])('rejects %s without exposing its value', (name) => {
      const secret = 'http://proxy-secret.invalid';
      try {
        assertNoConfidenceContractProxy({ [name]: secret });
        throw new Error('Expected proxy preflight rejection.');
      } catch (error) {
        expect((error as Error).message).toBe('proxy_configuration_not_allowed');
        expect((error as Error).message).not.toContain(secret);
      }
    });

  it.each([
    [{ NODE_USE_ENV_PROXY: '1' }, []],
    [{ NODE_OPTIONS: '--use-env-proxy' }, []],
    [{ NODE_OPTIONS: '--use-env-proxy=on' }, []],
    [{}, ['--use-env-proxy']],
  ] as const)('rejects Node proxy routing flags without logging configuration values', (env, args) => {
    expect(() => assertNoConfidenceContractProxy(env, args)).toThrow('proxy_configuration_not_allowed');
  });

  it('allows the proxy-free local runtime and ignores disabled Node proxy mode', () => {
    expect(() => assertNoConfidenceContractProxy({ NODE_USE_ENV_PROXY: '0', NODE_OPTIONS: '--trace-warnings' }, []))
      .not.toThrow();
  });
});
