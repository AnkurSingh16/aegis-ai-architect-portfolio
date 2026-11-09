import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { reservePrivateReport, writePrivateReport } from './private-report.js';

describe('private one-time evaluation report storage', () => {
  it('creates a mode-0700 directory and mode-0600 report, and refuses overwrite', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aegis-eval-report-'));
    const report = join(root, 'private', 'result.json');
    try {
      const handle = await reservePrivateReport(report);
      try { await writePrivateReport(handle, { status: 'in_progress', planned: 6 }); }
      finally { await handle.close(); }
      expect((await stat(join(root, 'private'))).mode & 0o077).toBe(0);
      expect((await stat(report)).mode & 0o777).toBe(0o600);
      await expect(reservePrivateReport(report)).rejects.toMatchObject({ code: 'EEXIST' });
      expect(await readdir(join(root, 'private'))).toEqual(['result.json']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('fails closed on an already broad directory permission', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aegis-eval-report-'));
    const directory = join(root, 'private');
    const report = join(directory, 'result.json');
    try {
      const handle = await reservePrivateReport(report);
      await handle.close();
      await rm(report);
      const { chmod } = await import('node:fs/promises');
      await chmod(directory, 0o755);
      await expect(reservePrivateReport(report)).rejects.toThrow('permissions are unsafe');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
