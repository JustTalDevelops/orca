import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'

/**
 * Which repositories have a worktree create in flight.
 *
 * Held for the whole create rather than per git command: background work that
 * only checked between the create's subprocesses would slip into every gap
 * (resolve base, fetch, `worktree add`, push target, listing the result).
 * Background producers defer new starts here; nothing already running is
 * stopped. Keyed by the repo root the create and the producers both know, never
 * a process cwd, so a scan from a sibling worktree of the same repo still sees it.
 */

export type WorktreeCreateRepo = { path: string }

/** Long enough to cover a create on a contended disk, short enough that a stuck create cannot starve background work. */
export const WORKTREE_CREATE_IDLE_WAIT_DEADLINE_MS = 3 * 60_000

const holds = new Map<string, number>()
const idleWaiters = new Map<string, Set<() => void>>()

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
      return
    }
    holds.delete(key)
    const waiters = idleWaiters.get(key)
    idleWaiters.delete(key)
    for (const wake of waiters ?? []) {
      wake()
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

/**
 * Resolves once no create holds `repoPath`, or at the deadline, whichever is
 * first. Never rejects: waiting is a courtesy to the create, not a precondition.
 */
export function waitForWorktreeCreateIdle(
  repoPath: string,
  deadlineMs: number = WORKTREE_CREATE_IDLE_WAIT_DEADLINE_MS
): Promise<void> {
  const key = repoKey(repoPath)
  if (!holds.has(key)) {
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    let waiters = idleWaiters.get(key)
    if (!waiters) {
      waiters = new Set()
      idleWaiters.set(key, waiters)
    }
    const wake = (): void => {
      clearTimeout(timer)
      idleWaiters.get(key)?.delete(wake)
      if (idleWaiters.get(key)?.size === 0) {
        idleWaiters.delete(key)
      }
      resolve()
    }
    // Why a deadline rather than waiting on the next release: back-to-back creates can keep a repo held indefinitely.
    const timer = setTimeout(wake, deadlineMs)
    timer.unref?.()
    waiters.add(wake)
  })
}

export function _resetWorktreeCreateRepoActivityForTests(): void {
  holds.clear()
  for (const waiters of idleWaiters.values()) {
    for (const wake of waiters) {
      wake()
    }
  }
  idleWaiters.clear()
}
