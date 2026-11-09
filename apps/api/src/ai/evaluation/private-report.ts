import { mkdir, open, lstat, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Exclusive, private report reservation; an existing file blocks all repeat runs. */
export async function reservePrivateReport(path: string): Promise<FileHandle> {
  const directory = dirname(path);
  const privateParent = dirname(directory);
  try { await mkdir(privateParent, { recursive: true, mode: 0o700 }); }
  catch { throw new Error('Evaluation report parent is unavailable.'); }
  const parentInfo = await lstat(privateParent);
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory() || (parentInfo.mode & 0o077) !== 0) {
    throw new Error('Evaluation report parent permissions are unsafe.');
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o077) !== 0) {
    throw new Error('Evaluation report directory permissions are unsafe.');
  }
  return open(path, 'wx', 0o600);
}

/** Only callers with an already-sanitized report should use this private writer. */
export async function writePrivateReport(handle: FileHandle, report: unknown): Promise<void> {
  await handle.truncate(0);
  await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8' });
  await handle.sync();
}
