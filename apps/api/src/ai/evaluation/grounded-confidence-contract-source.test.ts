import { describe, expect, it } from 'vitest';
import { groundedConfidenceContractEvaluationBaseCommit, groundedConfidenceContractEvaluationBranch,
  verifyGroundedConfidenceContractEvaluationSource, type GitRead } from './source-identity.js';

const release = 'a'.repeat(40);
const tree = 'b'.repeat(40);
const reviewed = 'c'.repeat(40);
const otherTree = 'd'.repeat(40);

function git(options: { branch?: string; dirty?: string; head?: string; tree?: string; main?: string; mainTree?: string;
  reviewedTree?: string; badAncestor?: string } = {}): GitRead {
  return (args) => {
    const query = args.join(' ');
    if (query === 'branch --show-current') return options.branch ?? 'main';
    if (query === 'status --porcelain=v1') return options.dirty ?? '';
    if (query === 'rev-parse HEAD') return options.head ?? release;
    if (query === 'rev-parse HEAD^{tree}') return options.tree ?? tree;
    if (query === 'rev-parse origin/main') return options.main ?? release;
    if (query === 'rev-parse origin/main^{tree}') return options.mainTree ?? tree;
    if (query === `rev-parse origin/${groundedConfidenceContractEvaluationBranch}`) return reviewed;
    if (query === `rev-parse origin/${groundedConfidenceContractEvaluationBranch}^{tree}`) return options.reviewedTree ?? tree;
    if (query.startsWith('merge-base --is-ancestor')) {
      if (query === options.badAncestor) throw new Error('unapproved ancestry');
      return '';
    }
    throw new Error(`Unexpected Git query: ${query}`);
  };
}

describe('grounded confidence-contract release source identity', () => {
  it('accepts only clean synchronized merged main with the reviewed tree and approved ancestry', () => {
    expect(verifyGroundedConfidenceContractEvaluationSource(git())).toEqual({ codeCommit: release, treeHash: tree,
      sourceRef: 'origin/main', reviewedRefCommit: reviewed });
    const ancestryMain = `merge-base --is-ancestor ${groundedConfidenceContractEvaluationBaseCommit} ${release}`;
    const ancestryFeature = `merge-base --is-ancestor ${groundedConfidenceContractEvaluationBaseCommit} ${reviewed}`;
    expect(() => verifyGroundedConfidenceContractEvaluationSource(git({ branch: groundedConfidenceContractEvaluationBranch })))
      .toThrow(/merged main/);
    expect(() => verifyGroundedConfidenceContractEvaluationSource(git({ dirty: ' M file.ts' }))).toThrow(/clean/);
    expect(() => verifyGroundedConfidenceContractEvaluationSource(git({ main: 'e'.repeat(40) }))).toThrow(/origin\/main/);
    expect(() => verifyGroundedConfidenceContractEvaluationSource(git({ mainTree: otherTree }))).toThrow(/origin\/main/);
    expect(() => verifyGroundedConfidenceContractEvaluationSource(git({ reviewedTree: otherTree }))).toThrow(/reviewed source tree/);
    expect(() => verifyGroundedConfidenceContractEvaluationSource(git({ badAncestor: ancestryMain }))).toThrow(/unapproved ancestry/);
    expect(() => verifyGroundedConfidenceContractEvaluationSource(git({ badAncestor: ancestryFeature }))).toThrow(/unapproved ancestry/);
    expect(() => verifyGroundedConfidenceContractEvaluationSource(git({ head: 'f'.repeat(40) }))).toThrow(/origin\/main/);
  });
});
