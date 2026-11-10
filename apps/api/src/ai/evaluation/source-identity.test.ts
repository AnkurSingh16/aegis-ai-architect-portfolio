import { describe, expect, it } from 'vitest';
import { groundedEvaluationBaseCommit, verifyGroundedEvaluationSource, type GitRead } from './source-identity.js';

const commit = 'a'.repeat(40);
const remoteCommit = 'b'.repeat(40);
const tree = 'c'.repeat(40);
const remoteTree = 'd'.repeat(40);
const feature = 'feat/m4-grounded-ai-intelligence';

function readGit(overrides: Record<string, string | Error> = {}, branch = feature): GitRead {
  return (args) => {
    const key = args.join(' ');
    if (overrides[key] instanceof Error) throw overrides[key];
    if (typeof overrides[key] === 'string') return overrides[key] as string;
    if (key === 'branch --show-current') return branch;
    if (key === 'status --porcelain=v1') return '';
    if (key === 'rev-parse HEAD') return remoteCommit;
    if (key === 'rev-parse HEAD^{tree}') return remoteTree;
    if (key === 'rev-parse origin/feat/m4-grounded-ai-intelligence') return remoteCommit;
    if (key === 'rev-parse origin/feat/m4-grounded-ai-intelligence^{tree}') return remoteTree;
    if (key.startsWith('merge-base --is-ancestor')) return '';
    return overrides[key] as string ?? '';
  };
}

describe('grounded evaluation source identity', () => {
  it('accepts only the clean local feature branch at the exact remote feature head', () => {
    expect(verifyGroundedEvaluationSource(readGit())).toEqual({ codeCommit: remoteCommit, treeHash: remoteTree });
    expect(() => verifyGroundedEvaluationSource(readGit({ 'rev-parse HEAD': commit }))).toThrow(/remote head/);
  });

  it('allows post-merge main only when its clean tree equals the preserved feature tree', () => {
    expect(verifyGroundedEvaluationSource(readGit({}, 'main'))).toEqual({ codeCommit: remoteCommit, treeHash: remoteTree });
    expect(() => verifyGroundedEvaluationSource(readGit({ 'rev-parse HEAD^{tree}': tree }, 'main'))).toThrow(/does not match/);
  });

  it('rejects dirty trees, unexpected branches, and sources without the expected base ancestor', () => {
    expect(() => verifyGroundedEvaluationSource(readGit({ 'status --porcelain=v1': ' M source.ts' }))).toThrow(/clean/);
    expect(() => verifyGroundedEvaluationSource(readGit({}, 'other-branch'))).toThrow(/approved feature branch/);
    expect(() => verifyGroundedEvaluationSource(readGit({ [`merge-base --is-ancestor ${groundedEvaluationBaseCommit} HEAD`]: new Error('not ancestor') })))
      .toThrow(/not ancestor/);
  });
});
