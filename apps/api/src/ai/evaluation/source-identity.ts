export const groundedEvaluationBaseCommit = '4690bb305f959f89ca2090a56982891158e77fe5';
export const groundedEvaluationFeatureBranch = 'feat/m4-grounded-ai-intelligence';
const remoteFeature = 'origin/feat/m4-grounded-ai-intelligence';

export type GitRead = (args: readonly string[]) => string;
export interface EvaluationSourceIdentity { codeCommit: string; treeHash: string }

/** Allows only the exact published feature head or a clean merged main with the same tree. */
export function verifyGroundedEvaluationSource(readGit: GitRead): EvaluationSourceIdentity {
  const branch = readGit(['branch', '--show-current']);
  if (readGit(['status', '--porcelain=v1']) !== '') throw new Error('Grounded evaluation requires a clean source tree.');
  const codeCommit = readGit(['rev-parse', 'HEAD']);
  const treeHash = readGit(['rev-parse', 'HEAD^{tree}']);
  const remoteHead = readGit(['rev-parse', remoteFeature]);
  const remoteTree = readGit(['rev-parse', `${remoteFeature}^{tree}`]);
  readGit(['merge-base', '--is-ancestor', groundedEvaluationBaseCommit, 'HEAD']);
  readGit(['merge-base', '--is-ancestor', groundedEvaluationBaseCommit, remoteFeature]);

  if (branch === groundedEvaluationFeatureBranch) {
    if (codeCommit !== remoteHead || treeHash !== remoteTree) throw new Error('Grounded evaluation feature source does not equal its preserved remote head.');
  } else if (branch === 'main') {
    if (treeHash !== remoteTree) throw new Error('Main source tree does not match the preserved reviewed evaluation tree.');
  } else {
    throw new Error('Grounded evaluation requires the approved feature branch or merged main.');
  }
  return { codeCommit, treeHash };
}
