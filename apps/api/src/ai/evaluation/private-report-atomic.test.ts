import { mkdtemp, readFile, readdir, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { replacePrivateReportAtomically, reservePrivateReport } from './private-report.js';

// Fault injection at the fs boundary. Each fault is armed only for the call under test and
// cleared afterwards, so the rest of the file uses the real filesystem.
const faults = vi.hoisted(() => ({
  openTemporary: undefined as Error | undefined,
  fileSync: undefined as Error | undefined,
  directorySync: undefined as Error | undefined,
  rename: undefined as Error | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const wrapHandle = (handle: FileHandle, directory: boolean): FileHandle => new Proxy(handle, {
    get(target, property) {
      if (property === 'sync') {
        return async () => {
          const fault = directory ? faults.directorySync : faults.fileSync;
          if (fault) throw fault;
          return target.sync();
        };
      }
      const value = Reflect.get(target, property) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const flags = args[1];
      if (flags === 'wx' && faults.openTemporary) throw faults.openTemporary;
      const handle = await actual.open(...args);
      return wrapHandle(handle, flags === 'r');
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (faults.rename) throw faults.rename;
      return actual.rename(...args);
    },
  };
});

const previousReport = { status: 'in_progress', planned: 6 };
const nextReport = { status: 'completed', attempted: 6, succeeded: 5, failed: 1 };

async function reservedReport(): Promise<{ root: string; directory: string; reportPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'aegis-eval-report-atomic-'));
  const directory = join(root, 'private');
  const reportPath = join(directory, 'result.json');
  const reservation = await reservePrivateReport(reportPath);
  await reservation.close();
  await replacePrivateReportAtomically(reportPath, previousReport);
  return { root, directory, reportPath };
}

function fault(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('atomic private report replacement under injected filesystem faults', () => {
  const roots: string[] = [];

  afterEach(async () => {
    faults.openTemporary = undefined;
    faults.fileSync = undefined;
    faults.directorySync = undefined;
    faults.rename = undefined;
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('keeps the previous complete report when the temporary file cannot be created', async () => {
    const { root, directory, reportPath } = await reservedReport();
    roots.push(root);
    faults.openTemporary = fault('permission denied', 'EACCES');

    await expect(replacePrivateReportAtomically(reportPath, nextReport)).rejects.toThrow('permission denied');

    expect(JSON.parse(await readFile(reportPath, 'utf8'))).toEqual(previousReport);
    expect(await readdir(directory)).toEqual(['result.json']);
  });

  it('keeps the previous complete report and removes the temporary file when its fsync fails', async () => {
    const { root, directory, reportPath } = await reservedReport();
    roots.push(root);
    faults.fileSync = fault('disk full', 'ENOSPC');

    await expect(replacePrivateReportAtomically(reportPath, nextReport)).rejects.toThrow('disk full');

    expect(JSON.parse(await readFile(reportPath, 'utf8'))).toEqual(previousReport);
    expect(await readdir(directory)).toEqual(['result.json']);
  });

  it('keeps the previous complete report and removes the temporary file when rename fails', async () => {
    const { root, directory, reportPath } = await reservedReport();
    roots.push(root);
    faults.rename = fault('rename refused', 'EXDEV');

    await expect(replacePrivateReportAtomically(reportPath, nextReport)).rejects.toThrow('rename refused');

    expect(JSON.parse(await readFile(reportPath, 'utf8'))).toEqual(previousReport);
    expect(await readdir(directory)).toEqual(['result.json']);
  });

  it('reports an error after the commit point while leaving the new complete report in place', async () => {
    // Once rename succeeds the new report is the file on disk. A failed directory fsync is
    // surfaced as an error so the caller cannot treat the update as durable, but it does not
    // roll the file back. Callers must treat that state as "new content, durability unconfirmed".
    const { root, directory, reportPath } = await reservedReport();
    roots.push(root);
    faults.directorySync = fault('directory sync unsupported', 'EIO');

    await expect(replacePrivateReportAtomically(reportPath, nextReport)).rejects.toThrow('directory sync unsupported');

    expect(JSON.parse(await readFile(reportPath, 'utf8'))).toEqual(nextReport);
    expect(await readdir(directory)).toEqual(['result.json']);
  });

  it('does not touch the previous report when the update is refused before any file operation', async () => {
    const { root, directory, reportPath } = await reservedReport();
    roots.push(root);
    const before = await readFile(reportPath, 'utf8');

    await expect(replacePrivateReportAtomically(reportPath, { status: 'completed', count: 1n }))
      .rejects.toThrow(TypeError);

    expect(await readFile(reportPath, 'utf8')).toBe(before);
    expect(await readdir(directory)).toEqual(['result.json']);
  });
});
