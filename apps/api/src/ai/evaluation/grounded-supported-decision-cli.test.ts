import { describe, expect, it } from 'vitest';
import { assertApprovedSupportedDecisionRuntime, assertNoSupportedDecisionProxy,
  safeSupportedDecisionCliFailure, supportedDecisionReportExitCode } from './run-grounded-supported-decision-local-evaluation.js';

describe('M4.18 supported-decision CLI safeguards', () => {
  it('accepts only the fixed local model, timeout, concurrency, endpoint, schema and six-slot contract', () => {
    expect(() => assertApprovedSupportedDecisionRuntime({ model: 'qwen2.5:3b-instruct', timeoutMs: 15000, maxConcurrent: 1 })).not.toThrow();
    expect(() => assertApprovedSupportedDecisionRuntime({ model: 'remote-model', timeoutMs: 15000, maxConcurrent: 1 })).toThrow();
    expect(() => assertApprovedSupportedDecisionRuntime({ model: 'qwen2.5:3b-instruct', timeoutMs: 15001, maxConcurrent: 1 })).toThrow();
    expect(() => assertApprovedSupportedDecisionRuntime({ model: 'qwen2.5:3b-instruct', timeoutMs: 15000, maxConcurrent: 2 })).toThrow();
    expect(() => assertApprovedSupportedDecisionRuntime(undefined)).toThrow();
  });

  it('rejects proxy routing without exposing configured values', () => {
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
      expect(() => assertNoSupportedDecisionProxy({ [name]: 'http://sensitive.invalid' })).toThrow('proxy_configuration_not_allowed');
    }
    expect(() => assertNoSupportedDecisionProxy({ NODE_USE_ENV_PROXY: '1' })).toThrow('proxy_configuration_not_allowed');
    expect(() => assertNoSupportedDecisionProxy({ NODE_OPTIONS: '--use-env-proxy' })).toThrow('proxy_configuration_not_allowed');
    expect(() => assertNoSupportedDecisionProxy({}, ['--use-env-proxy'])).toThrow('proxy_configuration_not_allowed');
    expect(() => assertNoSupportedDecisionProxy({ NODE_USE_ENV_PROXY: '0' })).not.toThrow();
  });

  it('returns success only after a complete run with contract acceptance and emits fixed safe failure stages', () => {
    expect(supportedDecisionReportExitCode({ executionStatus: 'completed', contractAcceptanceStatus: 'passed' })).toBe(0);
    expect(supportedDecisionReportExitCode({ executionStatus: 'completed', contractAcceptanceStatus: 'failed' })).toBe(1);
    expect(supportedDecisionReportExitCode({ executionStatus: 'incomplete', contractAcceptanceStatus: 'passed' })).toBe(1);
    expect(safeSupportedDecisionCliFailure('provider_evaluation')).toContain('"failureStage":"provider_evaluation"');
    expect(safeSupportedDecisionCliFailure('raw secret response')).toContain('"failureStage":"unknown"');
    expect(safeSupportedDecisionCliFailure('raw secret response')).not.toContain('raw secret response');
  });
});
