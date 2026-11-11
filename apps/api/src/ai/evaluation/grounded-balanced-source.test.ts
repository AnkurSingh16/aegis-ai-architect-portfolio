import { describe, expect, it } from 'vitest';
import { groundedBalancedEvaluationBaseCommit, groundedBalancedEvaluationBranch,
  verifyGroundedBalancedEvaluationSource, type GitRead } from './source-identity.js';

const head = 'a'.repeat(40);
const tree = 'b'.repeat(40);
const reviewed = 'c'.repeat(40);
const wrongTree = 'd'.repeat(40);

function git(options: { branch?: string; dirty?: string; head?: string; headTree?: string; main?: string; mainTree?: string;
  reviewed?: string; reviewedTree?: string; failedAncestry?: string } = {}): GitRead {
  return (args) => {
    const command = args.join(' ');
    if (command === 'branch --show-current') return options.branch ?? 'main';
    if (command === 'status --porcelain=v1') return options.dirty ?? '';
    if (command === 'rev-parse HEAD') return options.head ?? head;
    if (command === 'rev-parse HEAD^{tree}') return options.headTree ?? tree;
    if (command === 'rev-parse origin/main') return options.main ?? head;
    if (command === 'rev-parse origin/main^{tree}') return options.mainTree ?? tree;
    if (command === `rev-parse origin/${groundedBalancedEvaluationBranch}`) return options.reviewed ?? reviewed;
    if (command === `rev-parse origin/${groundedBalancedEvaluationBranch}^{tree}`) return options.reviewedTree ?? tree;
    if (command.startsWith('merge-base --is-ancestor')) {
      if (command === options.failedAncestry) throw new Error('unapproved ancestry');
      return '';
    }
    throw new Error(`Unexpected git query: ${command}`);
  };
}

describe('balanced evaluation release source guard', () => {
  it('accepts clean merged main with approved ancestry and reviewed source tree', () => {
    expect(verifyGroundedBalancedEvaluationSource(git())).toEqual({ codeCommit: head, treeHash: tree,
      sourceRef: 'origin/main', reviewedRefCommit: reviewed });
  });

  it('rejects dirty, feature, stale, unknown-tree, or unapproved-ancestry sources', () => {
    expect(() => verifyGroundedBalancedEvaluationSource(git({ branch: groundedBalancedEvaluationBranch }))).toThrow(/merged main/);
    expect(() => verifyGroundedBalancedEvaluationSource(git({ dirty: ' M file.ts' }))).toThrow(/clean/);
    expect(() => verifyGroundedBalancedEvaluationSource(git({ main: 'e'.repeat(40) }))).toThrow(/origin\/main/);
    expect(() => verifyGroundedBalancedEvaluationSource(git({ reviewedTree: wrongTree }))).toThrow(/reviewed source tree/);
    const badHead = `merge-base --is-ancestor ${groundedBalancedEvaluationBaseCommit} ${head}`;
    expect(() => verifyGroundedBalancedEvaluationSource(git({ failedAncestry: badHead }))).toThrow(/unapproved ancestry/);
    const badReviewed = `merge-base --is-ancestor ${groundedBalancedEvaluationBaseCommit} ${reviewed}`;
    expect(() => verifyGroundedBalancedEvaluationSource(git({ failedAncestry: badReviewed }))).toThrow(/unapproved ancestry/);
  });
});
