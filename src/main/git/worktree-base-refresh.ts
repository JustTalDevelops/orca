import type { LocalBaseRefRefreshResult } from '../../shared/worktree/base-ref-drift-types'
import { retryOnGitLockContention } from '../../shared/git-lock-contention'
import { gitExecFileAsync, translateWslOutputPaths } from './runner'
import {
  evaluateLocalBaseRefRefreshability,
  getLocalBaseRefUpdateSuggestionForWorktreeCreate
} from './worktree-base-refresh-analysis'
import { parseWorktreeList } from '../../shared/git-worktree-porcelain-parser'
import type { AddWorktreeOptions, GitWorktreeExecOptions } from './worktree-operation-options'
import { gitExecOptions } from './worktree-operation-options'

export { getLocalBaseRefUpdateSuggestionForWorktreeCreate }

export async function refreshLocalBaseRefForWorktreeCreate(
  repoPath: string,
  baseBranch: string,
  remoteTrackingRef: string,
  remoteTrackingBase?: AddWorktreeOptions['remoteTrackingBase'],
  options: GitWorktreeExecOptions = {}
): Promise<LocalBaseRefRefreshResult | undefined> {
  const evaluation = await evaluateLocalBaseRefRefreshability(
    repoPath,
    baseBranch,
    remoteTrackingRef,
    remoteTrackingBase,
    options,
    // Why: an already-current local ref needs no owner check or reset; skipping both avoids a spurious dirty warning and index.lock churn.
    (behind) => behind > 0
  )
  if (!evaluation) {
    return undefined
  }
  if (!evaluation.refreshable) {
    return evaluation.result
  }

  const resultBase = { baseRef: evaluation.baseRef, localBranch: evaluation.localBranch }
  const { fullRef, remoteOid, localOid, ownerWorktreePath } = evaluation
  // Why: a failed mutation is only an error if local is still behind; a concurrent refresh may already have fast-forwarded it.
  const rethrowUnlessAlreadyCurrent = async (error: unknown): Promise<void> => {
    if (!(await isLocalRefAt(repoPath, fullRef, remoteOid, options))) {
      throw error
    }
  }

  const attemptRefresh = async (): Promise<LocalBaseRefRefreshResult> => {
    if (ownerWorktreePath) {
      // Why: re-checked on every attempt; a lock-retry wait is long enough for the owner to change or get dirty.
      const { stdout: worktreeListOutput } = await gitExecFileAsync(
        ['worktree', 'list', '--porcelain'],
        gitExecOptions(repoPath, options)
      )
      const worktrees = parseWorktreeList(
        translateWslOutputPaths(worktreeListOutput, repoPath, options)
      )
      const currentOwner = worktrees.find((wt) => wt.branch === fullRef)
      if (!currentOwner || currentOwner.path !== ownerWorktreePath) {
        return { ...resultBase, status: 'skipped_error' }
      }
      const { stdout: status } = await gitExecFileAsync(
        ['status', '--porcelain', '--untracked-files=no'],
        gitExecOptions(currentOwner.path, options)
      )
      if (status.trim()) {
        return {
          ...resultBase,
          status: 'skipped_dirty_worktree',
          ownerWorktreePath: currentOwner.path
        }
      }
      await gitExecFileAsync(
        ['reset', '--hard', remoteOid],
        gitExecOptions(currentOwner.path, options)
      ).catch(rethrowUnlessAlreadyCurrent)
      return { ...resultBase, status: 'updated', ownerWorktreePath: currentOwner.path }
    }

    // Why: no owner worktree — fast-forward the bare ref; the expected-old-OID form is a no-op-safe CAS if the ref moved since evaluation.
    await gitExecFileAsync(
      ['update-ref', fullRef, remoteOid, localOid],
      gitExecOptions(repoPath, options)
    ).catch(rethrowUnlessAlreadyCurrent)
    return { ...resultBase, status: 'updated' }
  }

  try {
    return await retryOnGitLockContention(attemptRefresh)
  } catch {
    // update-ref/reset can fail on locked refs or odd worktree states; worktree creation should still proceed.
    return { ...resultBase, status: 'skipped_error' }
  }
}

async function isLocalRefAt(
  repoPath: string,
  fullRef: string,
  oid: string,
  options: GitWorktreeExecOptions
): Promise<boolean> {
  try {
    const { stdout } = await gitExecFileAsync(
      ['rev-parse', '--verify', `${fullRef}^{commit}`],
      gitExecOptions(repoPath, options)
    )
    return stdout.trim() === oid
  } catch {
    return false
  }
}
