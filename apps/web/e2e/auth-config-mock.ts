import type { AuthConfig } from '../src/auth/config';

/** E2E-only config shim; production and normal development keep the real origin guard. */
export function readAuthConfig(): AuthConfig {
  return { domain: 'synthetic-auth.example', clientId: 'synthetic-e2e-client', audience: 'https://synthetic-api.example' };
}

export function isApprovedLoopbackOrigin(origin: string): boolean {
  return origin === 'http://127.0.0.1:5174';
}
