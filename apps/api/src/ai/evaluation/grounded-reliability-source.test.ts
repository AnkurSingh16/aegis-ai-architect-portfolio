import { describe, expect, it } from 'vitest';
import { groundedReliabilityEvaluationBaseCommit, groundedReliabilityEvaluationBranch,
  verifyGroundedReliabilityEvaluationSource, type GitRead } from './source-identity.js';

const main = 'a'.repeat(40);
const tree = 'b'.repeat(40);
const reviewed = 'c'.repeat(40);

function git(options: { branch?: string; dirty?: string; current?: string; currentTree?: string; main?: string; mainTree?: string;
  reviewedTree?: string; noAncestry?: string } = {}): GitRead {
  return (args) => {
    const query = args.join(' ');
    if (query === 'branch --show-current') return options.branch ?? 'main';
    if (query === 'status --porcelain=v1') return options.dirty ?? '';
    if (query === 'rev-parse HEAD') return options.current ?? main;
    if (query === 'rev-parse HEAD^{tree}') return options.currentTree ?? tree;
    if (query === 'rev-parse origin/main') return options.main ?? main;
    if (query === 'rev-parse origin/main^{tree}') return options.mainTree ?? tree;
    if (query === `rev-parse origin/${groundedReliabilityEvaluationBranch}`) return reviewed;
    if (query === `rev-parse origin/${groundedReliabilityEvaluationBranch}^{tree}`) return options.reviewedTree ?? tree;
    if (query.startsWith('merge-base --is-ancestor')) {
      if (query === options.noAncestry) throw new Error('unapproved ancestry');
      return '';
    }
    throw new Error(`Unexpected Git query: ${query}`);
  };
}

describe('grounded reliability evaluation release source identity', () => {
  it('accepts only clean merged main matching the preserved reviewed tree and base ancestry', () => {
    expect(verifyGroundedReliabilityEvaluationSource(git())).toEqual({ codeCommit: main, treeHash: tree,
      sourceRef: 'origin/main', reviewedRefCommit: reviewed });
    expect(() => verifyGroundedReliabilityEvaluationSource(git({ branch: groundedReliabilityEvaluationBranch }))).toThrow(/merged main/);
    expect(() => verifyGroundedReliabilityEvaluationSource(git({ dirty: ' M source.ts' }))).toThrow(/clean/);
    expect(() => verifyGroundedReliabilityEvaluationSource(git({ main: 'd'.repeat(40) }))).toThrow(/origin\/main/);
    expect(() => verifyGroundedReliabilityEvaluationSource(git({ reviewedTree: 'e'.repeat(40) }))).toThrow(/reviewed source tree/);
  });

  it('requires ancestry from the merged balanced release for both main and reviewed source', () => {
    const mainAncestry = `merge-base --is-ancestor ${groundedReliabilityEvaluationBaseCommit} ${main}`;
    const branchAncestry = `merge-base --is-ancestor ${groundedReliabilityEvaluationBaseCommit} ${reviewed}`;
    expect(() => verifyGroundedReliabilityEvaluationSource(git({ noAncestry: mainAncestry }))).toThrow(/unapproved ancestry/);
    expect(() => verifyGroundedReliabilityEvaluationSource(git({ noAncestry: branchAncestry }))).toThrow(/unapproved ancestry/);
  });
});
