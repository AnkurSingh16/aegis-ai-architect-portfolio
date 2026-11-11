import { describe, expect, it } from 'vitest';
import { groundedTokenBudget512EvaluationBaseCommit, groundedTokenBudget512EvaluationBranch,
  verifyGroundedTokenBudget512EvaluationSource, type GitRead } from './source-identity.js';

const main = 'a'.repeat(40);
const tree = 'b'.repeat(40);
const reviewed = 'c'.repeat(40);

function git(options: { branch?: string; dirty?: string; current?: string; tree?: string; main?: string; mainTree?: string;
  reviewedTree?: string; badAncestor?: string } = {}): GitRead {
  return (args) => {
    const query = args.join(' ');
    if (query === 'branch --show-current') return options.branch ?? 'main';
    if (query === 'status --porcelain=v1') return options.dirty ?? '';
    if (query === 'rev-parse HEAD') return options.current ?? main;
    if (query === 'rev-parse HEAD^{tree}') return options.tree ?? tree;
    if (query === 'rev-parse origin/main') return options.main ?? main;
    if (query === 'rev-parse origin/main^{tree}') return options.mainTree ?? tree;
    if (query === `rev-parse origin/${groundedTokenBudget512EvaluationBranch}`) return reviewed;
    if (query === `rev-parse origin/${groundedTokenBudget512EvaluationBranch}^{tree}`) return options.reviewedTree ?? tree;
    if (query.startsWith('merge-base --is-ancestor')) {
      if (query === options.badAncestor) throw new Error('unapproved ancestry');
      return '';
    }
    throw new Error(`Unexpected Git query: ${query}`);
  };
}

describe('grounded token-budget release source identity', () => {
  it('accepts only clean synchronized main with the reviewed M4.15 tree and base ancestry', () => {
    expect(verifyGroundedTokenBudget512EvaluationSource(git())).toEqual({ codeCommit: main, treeHash: tree,
      sourceRef: 'origin/main', reviewedRefCommit: reviewed });
    expect(() => verifyGroundedTokenBudget512EvaluationSource(git({ branch: groundedTokenBudget512EvaluationBranch }))).toThrow(/merged main/);
    expect(() => verifyGroundedTokenBudget512EvaluationSource(git({ dirty: ' M file.ts' }))).toThrow(/clean/);
    expect(() => verifyGroundedTokenBudget512EvaluationSource(git({ main: 'd'.repeat(40) }))).toThrow(/origin\/main/);
    expect(() => verifyGroundedTokenBudget512EvaluationSource(git({ reviewedTree: 'e'.repeat(40) }))).toThrow(/reviewed source tree/);
  });

  it('requires the approved M4.14 release as ancestry for merged and reviewed refs', () => {
    const mainAncestry = `merge-base --is-ancestor ${groundedTokenBudget512EvaluationBaseCommit} ${main}`;
    const featureAncestry = `merge-base --is-ancestor ${groundedTokenBudget512EvaluationBaseCommit} ${reviewed}`;
    expect(() => verifyGroundedTokenBudget512EvaluationSource(git({ badAncestor: mainAncestry }))).toThrow(/unapproved ancestry/);
    expect(() => verifyGroundedTokenBudget512EvaluationSource(git({ badAncestor: featureAncestry }))).toThrow(/unapproved ancestry/);
  });
});
