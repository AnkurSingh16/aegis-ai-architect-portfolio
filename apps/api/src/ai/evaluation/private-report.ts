import { randomUUID } from 'node:crypto';
import { mkdir, open, lstat, rename, rm, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

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
  const contents = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeAllBytes(handle, contents);
  await handle.truncate(contents.byteLength);
  await handle.sync();
}

/**
 * Replaces a reserved report with complete contents using write-then-rename. The new bytes are
 * flushed to a private temporary file in the same directory and renamed over the reserved path,
 * so a failure before the rename leaves the previous complete report in place. Rename is atomic
 * on the same filesystem; this design does not by itself prove survival across power loss.
 */
export async function replacePrivateReportAtomically(path: string, report: unknown): Promise<void> {
  const directory = dirname(path);
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o077) !== 0) {
    throw new Error('Evaluation report directory permissions are unsafe.');
  }
  const reservation = await lstat(path);
  if (reservation.isSymbolicLink() || !reservation.isFile()) {
    throw new Error('Evaluation report reservation is invalid.');
  }
  const contents = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8');
  const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  let handle: FileHandle | null = null;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await writeAllBytes(handle, contents);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, path);
    await syncDirectory(directory);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function writeAllBytes(handle: FileHandle, contents: Buffer): Promise<void> {
  let written = 0;
  while (written < contents.byteLength) {
    const result = await handle.write(contents, written, contents.byteLength - written, written);
    if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0 ||
        result.bytesWritten > contents.byteLength - written) {
      throw new Error('Evaluation report write did not make safe progress.');
    }
    written += result.bytesWritten;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try { await handle.sync(); }
  finally { await handle.close(); }
}
