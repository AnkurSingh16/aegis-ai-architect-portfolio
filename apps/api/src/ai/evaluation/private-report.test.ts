import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
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

  it('rewrites sequential reports on one handle from offset zero without NULs or stale trailing bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aegis-eval-report-'));
    const directory = join(root, 'private');
    const reportPath = join(directory, 'result.json');
    const unrelatedPath = join(directory, 'keep.txt');
    const unrelatedContents = 'unrelated sentinel';
    const reports = [
      { status: 'in_progress', planned: 6 },
      { status: 'in_progress', planned: 6, progress: 'login canonical, billing canonical, guidance canonical' },
      { status: 'in_progress', completed: 1 },
      { status: 'completed', attempted: 6, succeeded: 5, failed: 1 },
      { status: 'stopped', attempted: 2, stoppedEarly: true },
    ];
    try {
      const handle = await reservePrivateReport(reportPath);
      await writeFile(unrelatedPath, unrelatedContents, { mode: 0o600 });
      try {
        for (const report of reports) {
          await writePrivateReport(handle, report);
          const bytes = await readFile(reportPath);
          expect(bytes.includes(0)).toBe(false);
          expect(bytes.toString('utf8')).toBe(`${JSON.stringify(report, null, 2)}\n`);
          expect(JSON.parse(bytes.toString('utf8'))).toEqual(report);
          expect((await stat(reportPath)).mode & 0o777).toBe(0o600);
        }
      } finally { await handle.close(); }
      expect((await stat(directory)).mode & 0o077).toBe(0);
      expect(await readFile(unrelatedPath, 'utf8')).toBe(unrelatedContents);
      expect(await readdir(directory)).toEqual(['keep.txt', 'result.json']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('retries partial writes using explicit contiguous offsets, then truncates exactly and syncs', async () => {
    const written: number[] = [];
    let file = Buffer.alloc(0);
    let truncatedTo = -1;
    let synced = false;
    const partialHandle = {
      async write(buffer: Buffer, bufferOffset: number, length: number, position: number) {
        expect(position).toBe(written.reduce((sum, count) => sum + count, 0));
        const bytesWritten = Math.min(3, length);
        const next = Buffer.from(buffer.subarray(bufferOffset, bufferOffset + bytesWritten));
        file = Buffer.concat([file.subarray(0, position), next]);
        written.push(bytesWritten);
        return { bytesWritten, buffer };
      },
      async truncate(length: number) {
        truncatedTo = length;
        file = file.subarray(0, length);
      },
      async sync() { synced = true; },
    } as unknown as import('node:fs/promises').FileHandle;
    const report = { status: 'completed', attempts: 6 };
    const expected = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);

    await writePrivateReport(partialHandle, report);

    expect(written.length).toBeGreaterThan(1);
    expect(file.equals(expected)).toBe(true);
    expect(truncatedTo).toBe(expected.byteLength);
    expect(synced).toBe(true);
  });

  it('leaves a failed partial report private and blocks automatic reservation retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aegis-eval-report-'));
    const reportPath = join(root, 'private', 'result.json');
    try {
      const handle = await reservePrivateReport(reportPath);
      const originalWrite = handle.write.bind(handle);
      let calls = 0;
      Object.defineProperty(handle, 'write', {
        value: async (buffer: Buffer, bufferOffset: number, length: number, position: number) => {
          calls += 1;
          if (calls > 1) throw new Error('simulated interrupted write');
          return originalWrite(buffer, bufferOffset, Math.min(5, length), position);
        },
      });
      try {
        await expect(writePrivateReport(handle, { status: 'in_progress', synthetic: true }))
          .rejects.toThrow('simulated interrupted write');
      } finally { await handle.close(); }
      expect((await stat(reportPath)).mode & 0o777).toBe(0o600);
      expect((await readFile(reportPath)).byteLength).toBe(5);
      await expect(reservePrivateReport(reportPath)).rejects.toMatchObject({ code: 'EEXIST' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
