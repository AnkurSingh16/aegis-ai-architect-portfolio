export type AuthConfig = {
  domain: string;
  clientId: string;
  audience: string;
};

type PublicEnvironment = Record<string, string | boolean | undefined>;

const approvedIssuer = 'https://dev-tzvthmve8npi2dw7.au.auth0.com/';
const approvedAudience = 'https://aegis-ai.local/api';
const approvedClientId = '9juCp3cwGwGBoRluIaqDb4PO8Ll4ilrN';

export function readAuthConfig(environment: PublicEnvironment): AuthConfig | null {
  if (environment.VITE_AUTH0_ENABLED !== 'true') return null;

  const issuer = environment.VITE_AUTH0_ISSUER;
  const clientId = environment.VITE_AUTH0_CLIENT_ID;
  const audience = environment.VITE_AUTH0_AUDIENCE;
  if (typeof issuer !== 'string' || typeof clientId !== 'string' || typeof audience !== 'string') return null;
  if (!clientId.trim() || !audience.trim()) return null;

  try {
    const url = new URL(issuer);
    if (issuer !== approvedIssuer || audience.trim() !== approvedAudience || clientId.trim() !== approvedClientId ||
      url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) return null;
    return { domain: url.hostname, clientId: clientId.trim(), audience: audience.trim() };
  } catch {
    return null;
  }
}

export function isApprovedLoopbackOrigin(origin: string): boolean {
  return origin === 'http://127.0.0.1:5173';
}
