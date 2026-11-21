import { describe, expect, it } from 'vitest';
import { ConfigurationError, parseRuntimeConfig, userManagerSettings } from './oidc-config';

const local = {
  version: 1,
  oidc: {
    environment: 'local', issuer: 'http://localhost:8180/realms/aegis', clientId: 'aegis-web', audience: 'aegis-api',
    scopes: ['openid', 'read:cases', 'write:cases'], redirectPath: '/', postLogoutRedirectPath: '/', apiBasePath: '/api',
    silentRenew: true,
  },
};
const withOidc = (patch: Record<string, unknown>) => ({ version: 1, oidc: { ...local.oidc, ...patch } });

describe('runtime OIDC configuration contract', () => {
  it('accepts a valid local configuration and defaults demonstration routes to off', () => {
    const parsed = parseRuntimeConfig(local);
    expect(parsed.oidc).toMatchObject({ environment: 'local', issuer: 'http://localhost:8180/realms/aegis', clientId: 'aegis-web',
      features: { demoRoutes: false } });
  });

  it('treats a missing or null oidc section as sign-in disabled, not as an error', () => {
    expect(parseRuntimeConfig({ version: 1 }).oidc).toBeNull();
    expect(parseRuntimeConfig({ version: 1, oidc: null }).oidc).toBeNull();
  });

  it('enables demonstration routes only when explicitly true', () => {
    expect(parseRuntimeConfig({ ...local, oidc: { ...local.oidc, features: { demoRoutes: true } } }).oidc?.features.demoRoutes).toBe(true);
    expect(parseRuntimeConfig({ ...local, oidc: { ...local.oidc, features: { demoRoutes: 'true' } } }).oidc?.features.demoRoutes).toBe(false);
  });

  it.each([
    ['unknown version', { ...local, version: 2 }],
    ['unknown environment', withOidc({ environment: 'dev' })],
    ['issuer that the URL parser would rewrite (non-canonical spelling)', withOidc({ issuer: 'HTTP://LOCALHOST:8180/realms/aegis' })],
    ['issuer with user information', withOidc({ issuer: 'http://user:pw@localhost:8180/realms/aegis' })],
    ['issuer with a query', withOidc({ issuer: 'http://localhost:8180/realms/aegis?x=1' })],
    ['plain HTTP issuer on a non-loopback host, even locally', withOidc({ issuer: 'http://keycloak:8080/realms/aegis' })],
    ['plain HTTP issuer outside a local environment', withOidc({ environment: 'production', issuer: 'http://localhost:8180/realms/aegis' })],
    ['staging with plain HTTP', withOidc({ environment: 'staging', issuer: 'http://localhost:8180/realms/aegis' })],
    ['empty client identifier', withOidc({ clientId: '' })],
    ['client identifier with spaces', withOidc({ clientId: 'aegis web' })],
    ['audience with surrounding whitespace', withOidc({ audience: ' aegis-api' })],
    ['scopes without openid', withOidc({ scopes: ['read:cases'] })],
    ['scope with an invalid character', withOidc({ scopes: ['openid', 'read cases'] })],
    ['too many scopes', withOidc({ scopes: Array.from({ length: 11 }, (_, i) => (i === 0 ? 'openid' : `s${i}`)) })],
    ['absolute redirect URL (open redirect)', withOidc({ redirectPath: 'https://evil.example/' })],
    ['protocol-relative redirect', withOidc({ redirectPath: '//evil.example/' })],
    ['redirect path with a query', withOidc({ redirectPath: '/callback?x=1' })],
    ['cross-origin API base', withOidc({ apiBasePath: 'https://api.example/api' })],
    ['non-boolean silent renew', withOidc({ silentRenew: 'yes' })],
  ])('fails closed for %s', (_label, raw) => {
    expect(() => parseRuntimeConfig(raw)).toThrow(ConfigurationError);
  });

  it('fails closed for a configuration that is not an object', () => {
    expect(() => parseRuntimeConfig(null)).toThrow(ConfigurationError);
    expect(() => parseRuntimeConfig('{}')).toThrow(ConfigurationError);
  });
});

describe('derived identity-library settings', () => {
  it('builds callback and logout URLs on the application origin and requests authorization code with PKCE', () => {
    const parsed = parseRuntimeConfig(local).oidc;
    if (!parsed) throw new Error('setup');
    const settings = userManagerSettings(parsed, 'http://localhost:5190');
    expect(settings).toMatchObject({
      authority: 'http://localhost:8180/realms/aegis',
      client_id: 'aegis-web',
      redirect_uri: 'http://localhost:5190/',
      post_logout_redirect_uri: 'http://localhost:5190/',
      response_type: 'code',
      scope: 'openid read:cases write:cases',
      automaticSilentRenew: true,
      loadUserInfo: false,
      monitorSession: false,
    });
    expect(settings).not.toHaveProperty('client_secret');
  });
});
