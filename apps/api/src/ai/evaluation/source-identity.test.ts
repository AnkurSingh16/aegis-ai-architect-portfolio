import { describe, expect, it } from 'vitest';
import { groundedEvaluationBaseCommit, groundedEvaluationCorrectionBaseCommit,
  groundedEvaluationCorrectionBranch, groundedEvaluationFeatureBranch, groundedEvaluationSchemaQualityBaseCommit,
  groundedEvaluationSchemaQualityBranch,
  verifyGroundedEvaluationSource, type GitRead } from './source-identity.js';

const originalCommit = 'a'.repeat(40);
const originalTree = 'b'.repeat(40);
const correctionCommit = 'c'.repeat(40);
const correctionTree = 'd'.repeat(40);
const mainCommit = 'e'.repeat(40);
const unreviewedTree = 'f'.repeat(40);
const schemaQualityCommit = '1'.repeat(40);
const schemaQualityTree = '2'.repeat(40);

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
});
