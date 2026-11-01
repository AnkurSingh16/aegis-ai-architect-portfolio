import { describe, expect, it } from 'vitest';
import { isApprovedLoopbackOrigin, readAuthConfig } from './config';

const valid = {
  VITE_AUTH0_ENABLED: 'true',
  VITE_AUTH0_ISSUER: 'https://dev-tzvthmve8npi2dw7.au.auth0.com/',
  VITE_AUTH0_CLIENT_ID: '9juCp3cwGwGBoRluIaqDb4PO8Ll4ilrN',
  VITE_AUTH0_AUDIENCE: 'https://aegis-ai.local/api',
};

describe('development Auth0 configuration', () => {
  it('accepts only the approved local issuer, audience and public client ID', () => {
    expect(readAuthConfig(valid)).toEqual({ domain: 'dev-tzvthmve8npi2dw7.au.auth0.com',
      clientId: valid.VITE_AUTH0_CLIENT_ID, audience: valid.VITE_AUTH0_AUDIENCE });
    expect(readAuthConfig({ ...valid, VITE_AUTH0_ISSUER: 'https://attacker.example/' })).toBeNull();
    expect(readAuthConfig({ ...valid, VITE_AUTH0_AUDIENCE: 'https://other.example/api' })).toBeNull();
    expect(readAuthConfig({ ...valid, VITE_AUTH0_CLIENT_ID: 'different-client' })).toBeNull();
    expect(readAuthConfig({ ...valid, VITE_AUTH0_ENABLED: 'false' })).toBeNull();
  });

  it('allows only the exact Vite loopback origin', () => {
    expect(isApprovedLoopbackOrigin('http://127.0.0.1:5173')).toBe(true);
    expect(isApprovedLoopbackOrigin('http://localhost:5173')).toBe(false);
    expect(isApprovedLoopbackOrigin('https://127.0.0.1:5173')).toBe(false);
    expect(isApprovedLoopbackOrigin('http://127.0.0.1:4000')).toBe(false);
  });
});
