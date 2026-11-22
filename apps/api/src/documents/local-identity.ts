import { createHash } from 'node:crypto';

/**
 * Compose-aware identity preflight for guarded local synthetic ingestion.
 *
 * The local stack is the Compose project `aegis-local` on a Docker context chosen in local configuration. The PostgreSQL container is
 * resolved through Compose labels, never by a historical container name. Its identity is pinned in local configuration (container ID
 * and PostgreSQL system identifier, recorded once by an operator) and every run fails closed when the live container or cluster differs.
 * Nothing here connects as an administrator, and nothing in source code hardcodes a system identifier.
 */

export const LOCAL_COMPOSE_PROJECT = 'aegis-local';
export const LOCAL_POSTGRES_SERVICE = 'postgres';
export const LOCAL_DATABASE = 'aegis_local';
export const LOCAL_INGEST_ROLE = 'aegis_ingest';
export const LOCAL_POSTGRES_IMAGE_PREFIX = 'pgvector/pgvector:pg17';

export class LocalIdentityError extends Error {
  constructor(readonly code: string) {
    super('Local ingestion preflight failed.');
  }
}

export interface PinnedLocalIdentity {
  readonly dockerContext: string;
  readonly containerId: string;
  readonly systemIdentifier: string;
  readonly port: number;
}

export interface ComposeContainerEntry {
  ID?: string;
  Service?: string;
  Project?: string;
  State?: string;
  Health?: string;
}

export interface InspectedPostgres {
  Id: string;
  Config: { Image: string; Labels: Record<string, string> | null };
  State: { Running?: boolean; Health?: { Status?: string } | null };
  NetworkSettings: { Ports: Record<string, Array<{ HostIp: string; HostPort: string }> | null> | null };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads the pinned identity from local configuration. Every value is format-checked; nothing is taken from source code. */
export function pinnedIdentityFromEnv(env: NodeJS.ProcessEnv): PinnedLocalIdentity {
  const dockerContext = env.AEGIS_LOCAL_DOCKER_CONTEXT ?? '';
  const containerId = (env.AEGIS_LOCAL_POSTGRES_CONTAINER_ID ?? '').toLowerCase();
  const systemIdentifier = env.AEGIS_LOCAL_POSTGRES_SYSTEM_IDENTIFIER ?? '';
  const port = Number(env.AEGIS_PORT_POSTGRES ?? '55432');
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(dockerContext) || !/^[0-9a-f]{12,64}$/.test(containerId) || !/^\d{10,25}$/.test(systemIdentifier) ||
      !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new LocalIdentityError('pinned_identity_invalid');
  }
  return { dockerContext, containerId, systemIdentifier, port };
}

/** Accepts `docker compose ps --format json` output as either a JSON array or newline-delimited objects. */
export function parseComposePs(output: string): ComposeContainerEntry[] {
  const trimmed = output.trim();
  if (trimmed === '') return [];
  const parsed: unknown = trimmed.startsWith('[') ? JSON.parse(trimmed) : trimmed.split('\n').filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as unknown);
  if (!Array.isArray(parsed)) throw new LocalIdentityError('compose_output_invalid');
  return parsed.filter(record) as ComposeContainerEntry[];
}

/** Exactly one running, healthy postgres service in the exact aegis-local project. */
export function selectPostgresContainer(entries: readonly ComposeContainerEntry[]): string {
  const matches = entries.filter((entry) => entry.Project === LOCAL_COMPOSE_PROJECT && entry.Service === LOCAL_POSTGRES_SERVICE);
  if (matches.length !== 1) throw new LocalIdentityError('container_not_unique');
  const [entry] = matches;
  if (!entry?.ID || entry.State !== 'running' || entry.Health !== 'healthy') throw new LocalIdentityError('container_not_healthy');
  return entry.ID;
}

/** Checks the inspected container against the pinned identity and the published loopback mapping. Labels only; no environment. */
export function verifyInspectedPostgres(inspected: unknown, pinned: PinnedLocalIdentity): void {
  if (!record(inspected)) throw new LocalIdentityError('inspect_invalid');
  const container = inspected as unknown as InspectedPostgres;
  const labels = container.Config?.Labels ?? {};
  const ports = container.NetworkSettings?.Ports?.['5432/tcp'];
  if (typeof container.Id !== 'string' || !container.Id.startsWith(pinned.containerId) ||
      labels['com.docker.compose.project'] !== LOCAL_COMPOSE_PROJECT || labels['com.docker.compose.service'] !== LOCAL_POSTGRES_SERVICE ||
      typeof container.Config?.Image !== 'string' || !container.Config.Image.startsWith(LOCAL_POSTGRES_IMAGE_PREFIX) ||
      container.State?.Running !== true || container.State?.Health?.Status !== 'healthy') {
    throw new LocalIdentityError('container_identity_mismatch');
  }
  if (!Array.isArray(ports) || ports.length !== 1 || ports[0]?.HostIp !== '127.0.0.1' || ports[0]?.HostPort !== String(pinned.port)) {
    throw new LocalIdentityError('published_port_mismatch');
  }
}

/** The ingestion URL must be the restricted role, the exact database, and the verified loopback port. Its password is never logged. */
export function validateLocalIngestionUrl(connectionString: string | undefined, port: number): URL {
  if (!connectionString) throw new LocalIdentityError('ingest_url_missing');
  let url: URL;
  try { url = new URL(connectionString); } catch { throw new LocalIdentityError('ingest_url_invalid'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' || Number(url.port) !== port ||
      url.pathname !== `/${LOCAL_DATABASE}` || url.username !== LOCAL_INGEST_ROLE || url.search !== '' || url.hash !== '') {
    throw new LocalIdentityError('ingest_url_invalid');
  }
  return url;
}

export interface QueryClient {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

/** Read-only check through the ingestion role itself: exact database, exact role and the pinned PostgreSQL system identifier. */
export async function verifyClusterIdentity(client: QueryClient, pinned: PinnedLocalIdentity): Promise<void> {
  const result = await client.query<{ database: string; role: string; systemIdentifier: string }>(
    `SELECT current_database() AS database, current_user AS role, (SELECT system_identifier::text FROM pg_control_system()) AS "systemIdentifier"`);
  const row = result.rows[0];
  if (!row || row.database !== LOCAL_DATABASE || row.role !== LOCAL_INGEST_ROLE || row.systemIdentifier !== pinned.systemIdentifier) {
    throw new LocalIdentityError('cluster_identity_mismatch');
  }
}

/** Typed confirmation bound to the verified target, so a stale or copied phrase cannot authorise a different cluster or catalogue. */
export function confirmationPhrase(pinned: PinnedLocalIdentity, catalogRevision: string): string {
  const token = createHash('sha256').update(`${pinned.systemIdentifier}:${pinned.containerId.slice(0, 12)}:${catalogRevision}`)
    .digest('hex').slice(0, 8).toUpperCase();
  return `INGEST SYNTHETIC CATALOG INTO aegis_local ${token}`;
}
