export interface AuthConfig { issuer: string; audience: string; databaseUrl: string }

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

export function validateIssuer(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid authentication configuration.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/'
    || url.search || url.hash || url.hostname === 'localhost' || url.hostname.endsWith('.localhost')
    || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(':') || value !== `${url.origin}/`
    || value.length > 255) throw new Error('Invalid authentication configuration.');
  return value;
}

export function resolveAuthConfig(env: NodeJS.ProcessEnv): AuthConfig | undefined {
  const { AUTH0_ISSUER: issuer, AUTH0_AUDIENCE: audience, DATABASE_URL: databaseUrl } = env;
  if (issuer === undefined && audience === undefined) return undefined;
  if (!issuer || !audience || audience.length > 255 || audience.trim() !== audience
    || /\s/.test(audience) || hasControlCharacter(audience) || !databaseUrl) throw new Error('Invalid authentication configuration.');
  return { issuer: validateIssuer(issuer), audience, databaseUrl };
}
