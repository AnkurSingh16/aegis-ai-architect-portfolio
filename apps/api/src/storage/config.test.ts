import { describe, expect, it } from 'vitest';
import { localDatabaseUrl } from './config.js';

describe('local database URL guard', () => {
  const remote = 'postgres://aegis_app:secret-value-here@postgres:5432/aegis_local';
  const loopback = 'postgres://aegis_app:secret-value-here@127.0.0.1:5432/aegis_local';

  it('always allows loopback hosts', () => {
    expect(localDatabaseUrl(loopback, {})).toBe(loopback);
    expect(localDatabaseUrl('postgres://u:p@localhost/db', {})).toBe('postgres://u:p@localhost/db');
  });

  it('refuses a named service host unless it is local and explicitly allowed', () => {
    expect(() => localDatabaseUrl(remote, {})).toThrow('Only a loopback');
    expect(() => localDatabaseUrl(remote, { AEGIS_ALLOWED_DATABASE_HOSTS: 'postgres' })).toThrow('Only a loopback');
    expect(() => localDatabaseUrl(remote, { AEGIS_ENVIRONMENT: 'production', AEGIS_ALLOWED_DATABASE_HOSTS: 'postgres' })).toThrow('Only a loopback');
  });

  it('allows a named service host only when local and listed', () => {
    expect(localDatabaseUrl(remote, { AEGIS_ENVIRONMENT: 'local', AEGIS_ALLOWED_DATABASE_HOSTS: 'postgres' })).toBe(remote);
    expect(localDatabaseUrl(remote, { AEGIS_ENVIRONMENT: 'local', AEGIS_ALLOWED_DATABASE_HOSTS: 'other, postgres' })).toBe(remote);
    expect(() => localDatabaseUrl(remote, { AEGIS_ENVIRONMENT: 'local', AEGIS_ALLOWED_DATABASE_HOSTS: 'other' })).toThrow('Only a loopback');
  });

  it('refuses query options, fragments and a missing database name even on loopback', () => {
    expect(() => localDatabaseUrl('postgres://u:p@127.0.0.1/db?sslmode=disable', {})).toThrow('Only a loopback');
    expect(() => localDatabaseUrl('postgres://u:p@127.0.0.1/', {})).toThrow('Only a loopback');
    expect(() => localDatabaseUrl('mysql://u:p@127.0.0.1/db', {})).toThrow('Only a loopback');
  });
});
