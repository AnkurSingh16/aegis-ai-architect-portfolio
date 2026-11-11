import { describe, expect, it } from 'vitest';
import { groundedContextEvaluationBaseCommit, groundedContextEvaluationBranch,
  verifyGroundedContextEvaluationSource, type GitRead } from './source-identity.js';

const commit = 'a'.repeat(40);
const tree = 'b'.repeat(40);
const reviewedCommit = 'c'.repeat(40);
const otherTree = 'd'.repeat(40);

function git(options: { branch?: string; dirty?: string; head?: string; headTree?: string; main?: string; mainTree?: string;
  reviewed?: string; reviewedTree?: string; failAncestry?: string } = {}): GitRead {
  return (args) => {
    const query = args.join(' ');
    if (query === 'branch --show-current') return options.branch ?? 'main';
    if (query === 'status --porcelain=v1') return options.dirty ?? '';
    if (query === 'rev-parse HEAD') return options.head ?? commit;
    if (query === 'rev-parse HEAD^{tree}') return options.headTree ?? tree;
    if (query === 'rev-parse origin/main') return options.main ?? commit;
    if (query === 'rev-parse origin/main^{tree}') return options.mainTree ?? tree;
    if (query === `rev-parse origin/${groundedContextEvaluationBranch}`) return options.reviewed ?? reviewedCommit;
    if (query === `rev-parse origin/${groundedContextEvaluationBranch}^{tree}`) return options.reviewedTree ?? tree;
    if (query.startsWith('merge-base --is-ancestor')) {
      if (query === options.failAncestry) throw new Error('not an ancestor');
      return '';
    }
    throw new Error(`Unexpected query ${query}`);
  };
}

describe('context evaluation release source guard', () => {
  it('accepts only clean merged main matching the preserved reviewed context branch', () => {
    expect(verifyGroundedContextEvaluationSource(git())).toEqual({ codeCommit: commit, treeHash: tree,
      sourceRef: 'origin/main', reviewedRefCommit: reviewedCommit });
  });

  it('rejects feature-branch, dirty, stale, unreviewed, or unapproved-ancestry sources', () => {
    expect(() => verifyGroundedContextEvaluationSource(git({ branch: groundedContextEvaluationBranch }))).toThrow(/merged main/);
    expect(() => verifyGroundedContextEvaluationSource(git({ dirty: ' M file.ts' }))).toThrow(/clean/);
    expect(() => verifyGroundedContextEvaluationSource(git({ main: 'e'.repeat(40) }))).toThrow(/origin\/main/);
    expect(() => verifyGroundedContextEvaluationSource(git({ reviewedTree: otherTree }))).toThrow(/preserved reviewed source tree/);
    const failedAncestry = `merge-base --is-ancestor ${groundedContextEvaluationBaseCommit} ${commit}`;
    expect(() => verifyGroundedContextEvaluationSource(git({ failAncestry: failedAncestry }))).toThrow(/not an ancestor/);
    const failedReviewedAncestry = `merge-base --is-ancestor ${groundedContextEvaluationBaseCommit} ${reviewedCommit}`;
    expect(() => verifyGroundedContextEvaluationSource(git({ failAncestry: failedReviewedAncestry }))).toThrow(/not an ancestor/);
  });
});
