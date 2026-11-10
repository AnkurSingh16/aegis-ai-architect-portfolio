import { describe, expect, it } from 'vitest';
import { groundedEvaluationBaseCommit, groundedEvaluationCorrectionBaseCommit,
  groundedEvaluationCorrectionBranch, groundedEvaluationFeatureBranch, groundedEvaluationSchemaQualityBaseCommit,
  groundedEvaluationSchemaQualityBranch, groundedEvaluationV3Branch, groundedEvaluationV3ReleaseBaseCommit,
  verifyGroundedEvaluationSource, verifyGroundedEvaluationV3Source, type GitRead } from './source-identity.js';

const originalCommit = 'a'.repeat(40);
const originalTree = 'b'.repeat(40);
const correctionCommit = 'c'.repeat(40);
const correctionTree = 'd'.repeat(40);
const mainCommit = 'e'.repeat(40);
const unreviewedTree = 'f'.repeat(40);
const schemaQualityCommit = '1'.repeat(40);
const schemaQualityTree = '2'.repeat(40);
const v3Commit = '3'.repeat(40);
const v3Tree = '4'.repeat(40);

interface Source {
  branch: string;
  commit: string;
  tree: string;
  mainCommit: string;
  mainTree: string;
  dirty?: string;
  noAncestry?: string;
}

function readGit(source: Source): GitRead {
  return (args) => {
    const key = args.join(' ');
    if (key === 'branch --show-current') return source.branch;
    if (key === 'status --porcelain=v1') return source.dirty ?? '';
    if (key === 'rev-parse HEAD') return source.commit;
    if (key === 'rev-parse HEAD^{tree}') return source.tree;
    if (key === 'rev-parse origin/main') return source.mainCommit;
    if (key === 'rev-parse origin/main^{tree}') return source.mainTree;
    if (key === `rev-parse origin/${groundedEvaluationFeatureBranch}`) return originalCommit;
    if (key === `rev-parse origin/${groundedEvaluationFeatureBranch}^{tree}`) return originalTree;
    if (key === `rev-parse origin/${groundedEvaluationCorrectionBranch}`) return correctionCommit;
    if (key === `rev-parse origin/${groundedEvaluationCorrectionBranch}^{tree}`) return correctionTree;
    if (key === `rev-parse origin/${groundedEvaluationSchemaQualityBranch}`) return schemaQualityCommit;
    if (key === `rev-parse origin/${groundedEvaluationSchemaQualityBranch}^{tree}`) return schemaQualityTree;
    if (key.startsWith('merge-base --is-ancestor')) {
      if (source.noAncestry === key) throw new Error('not an ancestor');
      return '';
    }
    throw new Error(`Unexpected git query: ${key}`);
  };
}

const source = (branch: string, commit: string, tree: string, mainTree = correctionTree): Source => ({
  branch, commit, tree, mainCommit, mainTree,
});

describe('grounded evaluation source identity', () => {
  it('accepts the original preserved, clean Milestone 4 feature source', () => {
    expect(verifyGroundedEvaluationSource(readGit(source(groundedEvaluationFeatureBranch, originalCommit, originalTree))))
      .toEqual({ codeCommit: originalCommit, treeHash: originalTree,
        sourceRef: `origin/${groundedEvaluationFeatureBranch}`, reviewedRefCommit: originalCommit });
  });

  it('accepts the corrective source only at its exact preserved remote head and base ancestry', () => {
    expect(verifyGroundedEvaluationSource(readGit(source(groundedEvaluationCorrectionBranch, correctionCommit, correctionTree))))
      .toEqual({ codeCommit: correctionCommit, treeHash: correctionTree,
        sourceRef: `origin/${groundedEvaluationCorrectionBranch}`, reviewedRefCommit: correctionCommit });
    expect(() => verifyGroundedEvaluationSource(readGit({ ...source(groundedEvaluationCorrectionBranch, correctionCommit, correctionTree),
      noAncestry: `merge-base --is-ancestor ${groundedEvaluationCorrectionBaseCommit} ${correctionCommit}` })))
      .toThrow(/not an ancestor/);
    expect(() => verifyGroundedEvaluationSource(readGit({ ...source(groundedEvaluationFeatureBranch, originalCommit, originalTree),
      noAncestry: `merge-base --is-ancestor ${groundedEvaluationBaseCommit} ${originalCommit}` })))
      .toThrow(/not an ancestor/);
  });

  it('rejects pre-merge evaluation on the moving schema-quality branch', () => {
    expect(() => verifyGroundedEvaluationSource(readGit(source(groundedEvaluationSchemaQualityBranch, schemaQualityCommit, schemaQualityTree))))
      .toThrow(/approved source branch/);
  });

  it('accepts post-squash main only when clean, current with origin, and tree-equal to a preserved reviewed ref', () => {
    expect(verifyGroundedEvaluationSource(readGit(source('main', mainCommit, correctionTree))))
      .toEqual({ codeCommit: mainCommit, treeHash: correctionTree,
        sourceRef: 'origin/main', reviewedRefCommit: correctionCommit });
    expect(verifyGroundedEvaluationSource(readGit(source('main', mainCommit, originalTree, originalTree))))
      .toEqual({ codeCommit: mainCommit, treeHash: originalTree,
        sourceRef: 'origin/main', reviewedRefCommit: originalCommit });
    expect(verifyGroundedEvaluationSource(readGit(source('main', mainCommit, schemaQualityTree, schemaQualityTree))))
      .toEqual({ codeCommit: mainCommit, treeHash: schemaQualityTree,
        sourceRef: 'origin/main', reviewedRefCommit: schemaQualityCommit });
    expect(() => verifyGroundedEvaluationSource(readGit({ ...source('main', mainCommit, schemaQualityTree, schemaQualityTree),
      noAncestry: `merge-base --is-ancestor ${groundedEvaluationSchemaQualityBaseCommit} ${mainCommit}` })))
      .toThrow(/not an ancestor/);
  });

  it('rejects dirty trees, arbitrary branches, unreviewed changes, stale main and invalid base ancestry', () => {
    expect(() => verifyGroundedEvaluationSource(readGit({ ...source(groundedEvaluationCorrectionBranch, correctionCommit, correctionTree),
      dirty: ' M source.ts' }))).toThrow(/clean/);
    expect(() => verifyGroundedEvaluationSource(readGit(source('unreviewed/topic', correctionCommit, correctionTree))))
      .toThrow(/approved source branch/);
    expect(() => verifyGroundedEvaluationSource(readGit(source(groundedEvaluationCorrectionBranch, correctionCommit, unreviewedTree))))
      .toThrow(/preserved reviewed remote head/);
    expect(() => verifyGroundedEvaluationSource(readGit(source('main', mainCommit, correctionTree, unreviewedTree))))
      .toThrow(/origin\/main/);
    expect(() => verifyGroundedEvaluationSource(readGit(source('main', originalCommit, correctionTree))))
      .toThrow(/origin\/main/);
    expect(() => verifyGroundedEvaluationSource(readGit({ ...source('main', mainCommit, correctionTree),
      noAncestry: `merge-base --is-ancestor ${groundedEvaluationCorrectionBaseCommit} ${mainCommit}` })))
      .toThrow(/not an ancestor/);
    expect(() => verifyGroundedEvaluationSource(readGit({ ...source(groundedEvaluationCorrectionBranch, correctionCommit, correctionTree),
      noAncestry: `merge-base --is-ancestor ${groundedEvaluationCorrectionBaseCommit} ${correctionCommit}` })))
      .toThrow(/not an ancestor/);
  });

  it('accepts v3 only on clean main after the PR #46 release base with the preserved v3 branch tree', () => {
    const readV3Git: GitRead = (args) => {
      const key = args.join(' ');
      if (key === 'branch --show-current') return 'main';
      if (key === 'status --porcelain=v1') return '';
      if (key === 'rev-parse HEAD') return mainCommit;
      if (key === 'rev-parse HEAD^{tree}') return v3Tree;
      if (key === 'rev-parse origin/main') return mainCommit;
      if (key === 'rev-parse origin/main^{tree}') return v3Tree;
      if (key === `rev-parse origin/${groundedEvaluationV3Branch}`) return v3Commit;
      if (key === `rev-parse origin/${groundedEvaluationV3Branch}^{tree}`) return v3Tree;
      if (key === `merge-base --is-ancestor ${groundedEvaluationV3ReleaseBaseCommit} ${mainCommit}` ||
          key === `merge-base --is-ancestor ${groundedEvaluationV3ReleaseBaseCommit} ${v3Commit}`) return '';
      throw new Error(`Unexpected git query: ${key}`);
    };
    expect(verifyGroundedEvaluationV3Source(readV3Git)).toEqual({ codeCommit: mainCommit, treeHash: v3Tree,
      sourceRef: 'origin/main', reviewedRefCommit: v3Commit });
  });

  it('rejects v3 feature-branch execution, dirty trees, stale main, changed reviewed trees and missing release ancestry', () => {
    const makeReadV3Git = (options: { branch?: string; dirty?: string; mainCommit?: string; mainTree?: string;
      reviewedTree?: string; noAncestry?: string } = {}): GitRead => (args) => {
      const key = args.join(' ');
      if (key === 'branch --show-current') return options.branch ?? 'main';
      if (key === 'status --porcelain=v1') return options.dirty ?? '';
      if (key === 'rev-parse HEAD') return mainCommit;
      if (key === 'rev-parse HEAD^{tree}') return v3Tree;
      if (key === 'rev-parse origin/main') return options.mainCommit ?? mainCommit;
      if (key === 'rev-parse origin/main^{tree}') return options.mainTree ?? v3Tree;
      if (key === `rev-parse origin/${groundedEvaluationV3Branch}`) return v3Commit;
      if (key === `rev-parse origin/${groundedEvaluationV3Branch}^{tree}`) return options.reviewedTree ?? v3Tree;
      if (key.startsWith('merge-base --is-ancestor')) {
        if (options.noAncestry === key) throw new Error('not an ancestor');
        return '';
      }
      throw new Error(`Unexpected git query: ${key}`);
    };
    expect(() => verifyGroundedEvaluationV3Source(makeReadV3Git({ branch: groundedEvaluationV3Branch }))).toThrow(/merged main/);
    expect(() => verifyGroundedEvaluationV3Source(makeReadV3Git({ dirty: ' M source.ts' }))).toThrow(/clean/);
    expect(() => verifyGroundedEvaluationV3Source(makeReadV3Git({ mainCommit: originalCommit }))).toThrow(/origin\/main/);
    expect(() => verifyGroundedEvaluationV3Source(makeReadV3Git({ mainTree: unreviewedTree }))).toThrow(/origin\/main/);
    expect(() => verifyGroundedEvaluationV3Source(makeReadV3Git({ reviewedTree: unreviewedTree }))).toThrow(/preserved reviewed source tree/);
    expect(() => verifyGroundedEvaluationV3Source(makeReadV3Git({
      noAncestry: `merge-base --is-ancestor ${groundedEvaluationV3ReleaseBaseCommit} ${mainCommit}`,
    }))).toThrow(/not an ancestor/);
    expect(() => verifyGroundedEvaluationV3Source(makeReadV3Git({
      noAncestry: `merge-base --is-ancestor ${groundedEvaluationV3ReleaseBaseCommit} ${v3Commit}`,
    }))).toThrow(/not an ancestor/);
  });
});
