import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'

/**
 * Which repositories have a local worktree create in flight. Read by the idle
 * ref-maintenance gate and by the PR conflict summary, which skips its base
 * fetch for background refreshes of a held repo. Nothing waits on a hold.
 *
 * Held for the whole create rather than per git command, so background work
 * cannot slip into the gaps between the create's subprocesses. Keyed by the
 * repo root the create and its readers both know, never a process cwd.
 */

export type WorktreeCreateRepo = { path: string }

const holds = new Map<string, number>()

function repoKey(repoPath: string): string {
  return normalizeRuntimePathForComparison(repoPath)
}

/** Returns an idempotent release; call it in `finally`. */
export function holdRepoForWorktreeCreate(repo: WorktreeCreateRepo): () => void {
  const key = repoKey(repo.path)
  holds.set(key, (holds.get(key) ?? 0) + 1)
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    const remaining = (holds.get(key) ?? 1) - 1
    if (remaining > 0) {
      holds.set(key, remaining)
    } else {
      holds.delete(key)
    }
  }
}

export async function runWithWorktreeCreateHold<T>(
  repo: WorktreeCreateRepo,
  operation: () => Promise<T>
): Promise<T> {
  const release = holdRepoForWorktreeCreate(repo)
  try {
    return await operation()
  } finally {
    release()
  }
}

export function isWorktreeCreateInFlight(repoPath: string): boolean {
  return holds.has(repoKey(repoPath))
}

export function hasWorktreeCreatesInFlight(): boolean {
  return holds.size > 0
}

export function _resetWorktreeCreateRepoActivityForTests(): void {
  holds.clear()
}
