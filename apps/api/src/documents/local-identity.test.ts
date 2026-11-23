import { describe, expect, it, vi } from 'vitest';
import {
  LocalIdentityError, confirmationPhrase, parseComposePs, pinnedIdentityFromEnv, selectPostgresContainer, validateLocalIngestionUrl,
  verifyClusterIdentity, verifyInspectedPostgres, type PinnedLocalIdentity,
} from './local-identity.js';

const containerId = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const pinned: PinnedLocalIdentity = { dockerContext: 'colima', containerId: containerId.slice(0, 12), systemIdentifier: '7701292369980424230', port: 55432 };
const inspected = {
  Id: containerId,
  Config: { Image: 'pgvector/pgvector:pg17', Labels: { 'com.docker.compose.project': 'aegis-local', 'com.docker.compose.service': 'postgres' } },
  State: { Running: true, Health: { Status: 'healthy' } },
  NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '55432' }] } },
};

function expectCode(action: () => unknown, code: string) {
  try { action(); } catch (error) {
    expect(error).toBeInstanceOf(LocalIdentityError);
    expect((error as LocalIdentityError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe('pinned local identity', () => {
  const env = { AEGIS_LOCAL_DOCKER_CONTEXT: 'colima', AEGIS_LOCAL_POSTGRES_CONTAINER_ID: containerId.slice(0, 12),
    AEGIS_LOCAL_POSTGRES_SYSTEM_IDENTIFIER: '7701292369980424230', AEGIS_PORT_POSTGRES: '55432' };

  it('reads the pinned values from local configuration with format checks', () => {
    expect(pinnedIdentityFromEnv(env)).toEqual(pinned);
    expectCode(() => pinnedIdentityFromEnv({ ...env, AEGIS_LOCAL_POSTGRES_SYSTEM_IDENTIFIER: 'not-a-number' }), 'pinned_identity_invalid');
    expectCode(() => pinnedIdentityFromEnv({ ...env, AEGIS_LOCAL_POSTGRES_CONTAINER_ID: 'short' }), 'pinned_identity_invalid');
    expectCode(() => pinnedIdentityFromEnv({ ...env, AEGIS_LOCAL_DOCKER_CONTEXT: 'bad context;rm' }), 'pinned_identity_invalid');
    expectCode(() => pinnedIdentityFromEnv({ ...env, AEGIS_LOCAL_DOCKER_CONTEXT: undefined }), 'pinned_identity_invalid');
  });

  it('never falls back to a historical or hardcoded identifier', () => {
    expectCode(() => pinnedIdentityFromEnv({ ...env, AEGIS_LOCAL_POSTGRES_SYSTEM_IDENTIFIER: undefined }), 'pinned_identity_invalid');
  });
});

describe('Compose container resolution', () => {
  it('parses JSON arrays and newline-delimited Compose output', () => {
    const entry = { ID: containerId.slice(0, 12), Service: 'postgres', Project: 'aegis-local', State: 'running', Health: 'healthy' };
    expect(parseComposePs(JSON.stringify([entry]))).toEqual([entry]);
    expect(parseComposePs(`${JSON.stringify(entry)}\n`)).toEqual([entry]);
    expect(parseComposePs('')).toEqual([]);
  });

  it('selects exactly one running, healthy postgres container in the aegis-local project', () => {
    const good = { ID: 'a1b2c3d4e5f6', Service: 'postgres', Project: 'aegis-local', State: 'running', Health: 'healthy' };
    expect(selectPostgresContainer([good])).toBe('a1b2c3d4e5f6');
    expectCode(() => selectPostgresContainer([]), 'container_not_unique');
    expectCode(() => selectPostgresContainer([good, { ...good, ID: 'ffffffffffff' }]), 'container_not_unique');
    expectCode(() => selectPostgresContainer([{ ...good, Project: 'aegis-ai-portfolio' }]), 'container_not_unique');
    expectCode(() => selectPostgresContainer([{ ...good, State: 'exited' }]), 'container_not_healthy');
    expectCode(() => selectPostgresContainer([{ ...good, Health: 'starting' }]), 'container_not_healthy');
  });

  it('accepts only the pinned container, the Compose labels and the exact loopback port mapping', () => {
    expect(() => verifyInspectedPostgres(inspected, pinned)).not.toThrow();
    const variants: unknown[] = [
      { ...inspected, Id: 'ffffffffffff0000000000000000000000000000000000000000000000000000' },
      { ...inspected, Config: { ...inspected.Config, Labels: { 'com.docker.compose.project': 'other', 'com.docker.compose.service': 'postgres' } } },
      { ...inspected, Config: { ...inspected.Config, Image: 'postgres:16' } },
      { ...inspected, State: { Running: true, Health: { Status: 'unhealthy' } } },
      { ...inspected, NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: '55432' }] } } },
      { ...inspected, NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '5432' }] } } },
      { ...inspected, NetworkSettings: { Ports: { '5432/tcp': null } } },
    ];
    for (const variant of variants) expect(() => verifyInspectedPostgres(variant, pinned)).toThrow(LocalIdentityError);
  });
});

describe('ingestion connection and identity', () => {
  it('requires the restricted role, exact database and verified loopback port', () => {
    expect(validateLocalIngestionUrl('postgres://aegis_ingest:synthetic-only@127.0.0.1:55432/aegis_local', 55432).pathname).toBe('/aegis_local');
    for (const url of [
      'postgres://aegis_ingest:x@127.0.0.1:55432/aegis_test',
      'postgres://aegis_ingest:x@localhost:55432/aegis_local',
      'postgres://aegis_ingest:x@127.0.0.1:5432/aegis_local',
      'postgres://aegis_admin:x@127.0.0.1:55432/aegis_local',
      'postgres://aegis_app:x@127.0.0.1:55432/aegis_local',
      'postgres://aegis_ingest:x@127.0.0.1:55432/aegis_local?sslmode=disable',
    ]) expectCode(() => validateLocalIngestionUrl(url, 55432), 'ingest_url_invalid');
    expectCode(() => validateLocalIngestionUrl(undefined, 55432), 'ingest_url_missing');
  });

  it('verifies cluster identity through the ingestion role itself and refuses any mismatch', async () => {
    const good = { database: 'aegis_local', role: 'aegis_ingest', systemIdentifier: pinned.systemIdentifier };
    const query = vi.fn().mockResolvedValue({ rows: [good] });
    await expect(verifyClusterIdentity({ query }, pinned)).resolves.toBeUndefined();
    expect(String(query.mock.calls[0]?.[0])).toContain('pg_control_system()');
    for (const mismatch of [{ ...good, database: 'aegis_test' }, { ...good, role: 'aegis_admin' }, { ...good, systemIdentifier: '1' }]) {
      await expect(verifyClusterIdentity({ query: vi.fn().mockResolvedValue({ rows: [mismatch] }) }, pinned))
        .rejects.toMatchObject({ code: 'cluster_identity_mismatch' });
    }
  });

  it('binds the typed confirmation to the verified cluster, container and catalogue revision', () => {
    const phrase = confirmationPhrase(pinned, 'aegis-support-docs-v1');
    expect(phrase).toMatch(/^INGEST SYNTHETIC CATALOG INTO aegis_local [0-9A-F]{8}$/);
    expect(confirmationPhrase(pinned, 'aegis-support-docs-v1')).toBe(phrase);
    expect(confirmationPhrase(pinned, 'aegis-support-docs-v2')).not.toBe(phrase);
    expect(confirmationPhrase({ ...pinned, systemIdentifier: '1234567890123' }, 'aegis-support-docs-v1')).not.toBe(phrase);
  });
});
