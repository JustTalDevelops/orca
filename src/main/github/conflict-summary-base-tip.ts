import { gitExecFileAsync } from '../git/runner'
import { resolveGitAdmissionTier } from '../git/command-runner/git-operation-executor'
import { gitOptionsForWorktree, type GitRuntimeOptions } from '../git/git-runtime-options'
import { isWorktreeCreateInFlight } from '../git/worktree-create-repo-activity'
import {
  buildConflictSummaryCacheKey,
  dedupeBaseOidResolve,
  type FreshBaseTipResolution,
  getConflictSummaryGitRuntimeKey,
  readFreshBaseTipResolution,
  readLastBaseTipResolution,
  rememberUnresolvedBaseTip,
  storeResolvedBaseTip
} from './conflict-summary-cache'

type LocalGitExecOptions = Pick<GitRuntimeOptions, 'wslDistro' | 'admissionTier'>

const BASE_REMOTE_NAME = 'origin'

// Why 5 min: covers the slowest create seen (268 s on 2026-09-28); a longer hold fetches as usual.
const WORKTREE_CREATE_BASE_TIP_MAX_AGE_MS = 5 * 60_000

export async function resolveLatestBaseOidThrottled(
  repoPath: string,
  baseRefName: string,
  fallbackBaseOid: string,
  localGitOptions: LocalGitExecOptions
): Promise<string> {
  const runtimeKey = getConflictSummaryGitRuntimeKey(localGitOptions.wslDistro)
  const baseKey = buildConflictSummaryCacheKey(runtimeKey, repoPath, baseRefName)
  const cachedResolution = readFreshBaseTipResolution(baseKey)
  if (cachedResolution) {
    return cachedResolution.kind === 'resolved' ? cachedResolution.oid : fallbackBaseOid
  }
  if (
    resolveGitAdmissionTier(localGitOptions.admissionTier) === 'background' &&
    isWorktreeCreateInFlight(repoPath)
  ) {
    // Why outside the dedupe slot: an interactive caller joining it must never inherit a skipped fetch.
    const withoutFetch = await resolveBaseTipWithoutFetch(
      repoPath,
      baseRefName,
      baseKey,
      localGitOptions
    )
    if (withoutFetch) {
      return withoutFetch.kind === 'resolved' ? withoutFetch.oid : fallbackBaseOid
    }
  }
  return dedupeBaseOidResolve(baseKey, async () => {
    // Why re-check inside the dedupe slot: a sibling caller may have finished
    // resolving between our cache read and this factory starting.
    const freshResolution = readFreshBaseTipResolution(baseKey)
    if (freshResolution) {
      return freshResolution
    }
    const oid = await resolveLatestBaseOid(repoPath, baseRefName, localGitOptions)
    if (oid) {
      storeResolvedBaseTip(baseKey, oid)
      return { kind: 'resolved', oid }
    }
    // Why cache the unresolved probe, not the caller fallback: the fetch
    // attempt is branch-wide expensive work, but GitHub's baseRefOid is
    // PR-specific and must not leak to sibling PRs on the same base branch.
    rememberUnresolvedBaseTip(baseKey)
    return { kind: 'fallback-unresolved' }
  }).then((resolution) => (resolution.kind === 'resolved' ? resolution.oid : fallbackBaseOid))
}

/**
 * Background refreshes skip the base fetch while a worktree create runs in the
 * repo, so neither the fetch nor the merge-tree a moved tip triggers competes
 * with it. Returns null when the last tip is too old and a fetch is due.
 * Nothing here is stored as fresh, so the first call after the create fetches.
 */
async function resolveBaseTipWithoutFetch(
  repoPath: string,
  baseRefName: string,
  baseKey: string,
  localGitOptions: LocalGitExecOptions
): Promise<FreshBaseTipResolution | null> {
  const last = readLastBaseTipResolution(baseKey)
  if (last) {
    return Date.now() - last.resolvedAt < WORKTREE_CREATE_BASE_TIP_MAX_AGE_MS
      ? last.resolution
      : null
  }
  const oid = await readRemoteTrackingTip(repoPath, baseRefName, localGitOptions)
  return oid ? { kind: 'resolved', oid } : { kind: 'fallback-unresolved' }
}

async function resolveLatestBaseOid(
  repoPath: string,
  baseRefName: string,
  localGitOptions: LocalGitExecOptions
): Promise<string | null> {
  try {
    // Why: cap the fetch at 10 s so slow or unreachable remotes don't block
    // the conflict-summary derivation indefinitely.
    await gitExecFileAsync(['fetch', '--quiet', BASE_REMOTE_NAME, baseRefName], {
      ...gitOptionsForWorktree(repoPath, localGitOptions),
      timeout: 10_000
    })
  } catch {
    // Why: fetching the base ref keeps the conflict list aligned with GitHub's
    // live mergeability view, but the card must still render offline. If fetch
    // fails, fall back to the base OID GitHub already gave us.
  }
  return readRemoteTrackingTip(repoPath, baseRefName, localGitOptions)
}

async function readRemoteTrackingTip(
  repoPath: string,
  baseRefName: string,
  localGitOptions: LocalGitExecOptions
): Promise<string | null> {
  for (const ref of [
    `refs/remotes/${BASE_REMOTE_NAME}/${baseRefName}`,
    `${BASE_REMOTE_NAME}/${baseRefName}`
  ]) {
    try {
      const { stdout } = await gitExecFileAsync(['rev-parse', '--verify', ref], {
        ...gitOptionsForWorktree(repoPath, localGitOptions)
      })
      const oid = stdout.trim()
      if (oid) {
        return oid
      }
    } catch {
      // Try the next ref form before falling back to GitHub's baseRefOid.
    }
  }

  return null
}
