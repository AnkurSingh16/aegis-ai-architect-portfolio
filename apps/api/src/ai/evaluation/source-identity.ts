export const groundedEvaluationBaseCommit = '4690bb305f959f89ca2090a56982891158e77fe5';
export const groundedEvaluationCorrectionBaseCommit = 'bd24e5bb366ed0147da08978009520c2f9c97ca4';
export const groundedEvaluationSchemaQualityBaseCommit = 'ca1a62aecf3ecd388afbbe4515d1dfcbe30d0105';
export const groundedEvaluationFeatureBranch = 'feat/m4-grounded-ai-intelligence';
export const groundedEvaluationCorrectionBranch = 'fix/m4-ingestion-server-ip';
export const groundedEvaluationSchemaQualityBranch = 'fix/m4-grounded-schema-quality';

const approvedSources = [
  { branch: groundedEvaluationFeatureBranch, ref: `origin/${groundedEvaluationFeatureBranch}`, base: groundedEvaluationBaseCommit, allowBranchEvaluation: true },
  { branch: groundedEvaluationCorrectionBranch, ref: `origin/${groundedEvaluationCorrectionBranch}`, base: groundedEvaluationCorrectionBaseCommit, allowBranchEvaluation: true },
  { branch: groundedEvaluationSchemaQualityBranch, ref: `origin/${groundedEvaluationSchemaQualityBranch}`,
    base: groundedEvaluationSchemaQualityBaseCommit, allowBranchEvaluation: false },
] as const;
const remoteMain = 'origin/main';

export type GitRead = (args: readonly string[]) => string;
export interface EvaluationSourceIdentity {
  codeCommit: string;
  treeHash: string;
  sourceRef: string;
  reviewedRefCommit: string;
}

function readRef(readGit: GitRead, ref: string): { commit: string; tree: string } {
  return { commit: readGit(['rev-parse', ref]), tree: readGit(['rev-parse', `${ref}^{tree}`]) };
}

function requireAncestry(readGit: GitRead, base: string, candidate: string): void {
  readGit(['merge-base', '--is-ancestor', base, candidate]);
}

function assertClean(readGit: GitRead): void {
  if (readGit(['status', '--porcelain=v1']) !== '') throw new Error('Grounded evaluation requires a clean source tree.');
}

/**
 * Accepts only preserved reviewed source refs. The release workflow must separately
 * verify CI on the exact corrective PR head before merge; Git tree checks preserve
 * that reviewed source identity without requiring GitHub access during local evaluation.
 */
export function verifyGroundedEvaluationSource(readGit: GitRead): EvaluationSourceIdentity {
  const branch = readGit(['branch', '--show-current']);
  assertClean(readGit);
  const codeCommit = readGit(['rev-parse', 'HEAD']);
  const treeHash = readGit(['rev-parse', 'HEAD^{tree}']);

  if (branch === 'main') {
    const main = readRef(readGit, remoteMain);
    if (codeCommit !== main.commit || treeHash !== main.tree) {
      throw new Error('Grounded evaluation main must equal the fetched origin/main release.');
    }
    for (const approved of approvedSources) {
      const reviewed = readRef(readGit, approved.ref);
      requireAncestry(readGit, approved.base, reviewed.commit);
      requireAncestry(readGit, approved.base, codeCommit);
      // Squash merges preserve the reviewed tree but not the original PR commit as an ancestor.
      if (treeHash === reviewed.tree) {
        return { codeCommit, treeHash, sourceRef: remoteMain, reviewedRefCommit: reviewed.commit };
      }
    }
    throw new Error('Grounded evaluation main tree does not match a preserved reviewed source ref.');
  }

  const approved = approvedSources.find((item) => item.branch === branch && item.allowBranchEvaluation);
  if (!approved) throw new Error('Grounded evaluation requires an approved source branch or merged main.');
  const reviewed = readRef(readGit, approved.ref);
  requireAncestry(readGit, approved.base, codeCommit);
  requireAncestry(readGit, approved.base, reviewed.commit);
  if (codeCommit !== reviewed.commit || treeHash !== reviewed.tree) {
    throw new Error('Grounded evaluation source does not equal its preserved reviewed remote head.');
  }
  return { codeCommit, treeHash, sourceRef: approved.ref, reviewedRefCommit: reviewed.commit };
}
