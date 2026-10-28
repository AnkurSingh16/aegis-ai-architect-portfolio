/** Server-owned synthetic identities. Never derive tenant context from HTTP input. */
const fixtures = {
  north: { tenantId: '10000000-0000-4000-8000-000000000001', name: 'Synthetic North' },
  south: { tenantId: '20000000-0000-4000-8000-000000000002', name: 'Synthetic South' },
} as const;

export type DevelopmentFixture = typeof fixtures[keyof typeof fixtures];

export function resolveFixture(value: string | undefined): DevelopmentFixture {
  if (value !== 'north' && value !== 'south') throw new Error('Choose AEGIS_DEV_FIXTURE=north or south.');
  return fixtures[value];
}

export function localDatabaseUrl(value: string | undefined): string {
  if (!value) throw new Error('A local database connection is required.');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid local database configuration.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.search || url.hash || !url.pathname.slice(1)) {
    throw new Error('Only a loopback PostgreSQL database URL without query options is supported.');
  }
  return value;
}

export function requireDevelopment(): void {
  if (process.env.NODE_ENV === 'production') throw new Error('Case storage commands are local-development only.');
}
