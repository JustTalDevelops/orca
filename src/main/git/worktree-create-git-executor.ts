import { createGitOperationExecutor } from './command-runner/git-operation-executor'
import { runWithWorktreeCreateHold, type WorktreeCreateRepo } from './worktree-create-repo-activity'

export const worktreeCreateGit = createGitOperationExecutor('interactive')

export const worktreePreparationGit = createGitOperationExecutor('status')

/** A local create: interactive git priority, and its repo held busy until it settles. */
export function runLocalWorktreeCreate<T>(
  repo: WorktreeCreateRepo,
  operation: () => Promise<T>
): Promise<T> {
  return runWithWorktreeCreateHold(repo, () => worktreeCreateGit.run(operation))
}
