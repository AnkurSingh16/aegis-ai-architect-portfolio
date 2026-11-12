import { describe, expect, it } from 'vitest';
import { groundedSupportedDecisionEvaluationBaseCommit, groundedSupportedDecisionEvaluationBranch,
  verifyGroundedSupportedDecisionEvaluationSource, type GitRead } from './source-identity.js';

const mainCommit = 'a'.repeat(40);
const reviewedCommit = 'c'.repeat(40);
const reviewedTree = 'b'.repeat(40);
const wrongTree = 'd'.repeat(40);

function mockedGit(options: { branch?: string; dirty?: string; head?: string; tree?: string; originMain?: string;
  originMainTree?: string; featureTree?: string; invalidAncestor?: string } = {}): GitRead {
  return (args) => {
    const query = args.join(' ');
    if (query === 'branch --show-current') return options.branch ?? 'main';
    if (query === 'status --porcelain=v1') return options.dirty ?? '';
    if (query === 'rev-parse HEAD') return options.head ?? mainCommit;
    if (query === 'rev-parse HEAD^{tree}') return options.tree ?? reviewedTree;
    if (query === 'rev-parse origin/main') return options.originMain ?? mainCommit;
    if (query === 'rev-parse origin/main^{tree}') return options.originMainTree ?? reviewedTree;
    if (query === `rev-parse origin/${groundedSupportedDecisionEvaluationBranch}`) return reviewedCommit;
    if (query === `rev-parse origin/${groundedSupportedDecisionEvaluationBranch}^{tree}`) return options.featureTree ?? reviewedTree;
    if (query.startsWith('merge-base --is-ancestor')) {
      if (query === options.invalidAncestor) throw new Error('unapproved ancestry');
      return '';
    }
    throw new Error(`Unexpected git read: ${query}`);
  };
}

describe('M4.18 supported-decision source identity', () => {
  it('accepts only clean synchronized main matching the preserved reviewed feature tree', () => {
    expect(verifyGroundedSupportedDecisionEvaluationSource(mockedGit())).toEqual({ codeCommit: mainCommit,
      treeHash: reviewedTree, sourceRef: 'origin/main', reviewedRefCommit: reviewedCommit });
    const mainAncestry = `merge-base --is-ancestor ${groundedSupportedDecisionEvaluationBaseCommit} ${mainCommit}`;
    const branchAncestry = `merge-base --is-ancestor ${groundedSupportedDecisionEvaluationBaseCommit} ${reviewedCommit}`;
    expect(() => verifyGroundedSupportedDecisionEvaluationSource(mockedGit({ branch: groundedSupportedDecisionEvaluationBranch })))
      .toThrow(/merged main/);
    expect(() => verifyGroundedSupportedDecisionEvaluationSource(mockedGit({ dirty: ' M source.ts' }))).toThrow(/clean/);
    expect(() => verifyGroundedSupportedDecisionEvaluationSource(mockedGit({ originMain: 'e'.repeat(40) }))).toThrow(/origin\/main/);
    expect(() => verifyGroundedSupportedDecisionEvaluationSource(mockedGit({ originMainTree: wrongTree }))).toThrow(/origin\/main/);
    expect(() => verifyGroundedSupportedDecisionEvaluationSource(mockedGit({ featureTree: wrongTree }))).toThrow(/reviewed source tree/);
    expect(() => verifyGroundedSupportedDecisionEvaluationSource(mockedGit({ head: 'f'.repeat(40) }))).toThrow(/origin\/main/);
    expect(() => verifyGroundedSupportedDecisionEvaluationSource(mockedGit({ invalidAncestor: mainAncestry }))).toThrow(/unapproved ancestry/);
    expect(() => verifyGroundedSupportedDecisionEvaluationSource(mockedGit({ invalidAncestor: branchAncestry }))).toThrow(/unapproved ancestry/);
  });
});
