import type { PRConflictSummary } from '../../shared/github/pull-request-types'
import {
  isUnsupportedMergeTreeMergeBaseError,
  isUnsupportedMergeTreeWriteTreeError
} from '../../shared/git-merge-tree-capability'
import { gitExecFileAsync } from '../git/runner'
import { gitOptionsForWorktree, type GitRuntimeOptions } from '../git/git-runtime-options'
import {
  clearGitCapabilityStateForTests,
  withLocalGitCapabilityCacheForExecution
} from '../git/git-capability-state'
import {
  __resetPRConflictSummaryDerivationCachesForTests,
  buildConflictSummaryCacheKey,
  dedupeSummaryDerivation,
  getConflictSummaryGitRuntimeKey,
  readCachedSummary,
  storeCachedSummary
} from './conflict-summary-cache'
import { resolveLatestBaseOidThrottled } from './conflict-summary-base-tip'

type LocalGitExecOptions = Pick<GitRuntimeOptions, 'wslDistro' | 'admissionTier'>

export function __resetPRConflictSummaryCachesForTests(): void {
  clearGitCapabilityStateForTests()
  __resetPRConflictSummaryDerivationCachesForTests()
}

export async function getPRConflictSummary(
  repoPath: string,
  baseRefName: string,
  baseRefOid: string,
  headRefOid: string,
  localGitOptions: LocalGitExecOptions = {}
): Promise<PRConflictSummary | undefined> {
  // Why: the renderer only needs a read-only merge-conflict snapshot. We
  // derive it from local git state so the PR card can show GitHub-style
  // detail without spending additional gh API calls on every refresh. We use
  // GitHub's head OID directly because the registered repo path may not have
  // a matching local branch name for the PR head. For the base side, prefer a
  // freshly-fetched remote-tracking ref so Orca matches GitHub's portal,
  // which compares against the latest base branch tip rather than the PR's
  // older pinned baseRefOid snapshot.
  const latestBaseOid = await resolveLatestBaseOidThrottled(
    repoPath,
    baseRefName,
    baseRefOid,
    localGitOptions
  )
  // Why: the summary is a pure function of the two commit OIDs, so a key hit
  // can skip the whole merge-base/rev-list/merge-tree subprocess chain.
  const runtimeKey = getConflictSummaryGitRuntimeKey(localGitOptions.wslDistro)
  const summaryKey = buildConflictSummaryCacheKey(
    runtimeKey,
    repoPath,
    baseRefName,
    headRefOid,
    latestBaseOid
  )
  const cached = readCachedSummary(summaryKey)
  if (cached) {
    return cached.value
  }

  // Why: different GitHub reads can report different pinned baseRefOid values
  // while still resolving to the same live base tip; dedupe the expensive
  // local derivation on the actual summary identity.
  return dedupeSummaryDerivation(summaryKey, () =>
    derivePRConflictSummary(
      repoPath,
      baseRefName,
      headRefOid,
      latestBaseOid,
      summaryKey,
      localGitOptions
    )
  )
}

async function derivePRConflictSummary(
  repoPath: string,
  baseRefName: string,
  headRefOid: string,
  latestBaseOid: string,
  summaryKey: string,
  localGitOptions: LocalGitExecOptions
): Promise<PRConflictSummary | undefined> {
  const cached = readCachedSummary(summaryKey)
  if (cached) {
    return cached.value
  }

  try {
    const mergeBase = await resolveMergeBase(repoPath, headRefOid, latestBaseOid, localGitOptions)
    const [commitsBehind, files] = await Promise.all([
      countCommits(repoPath, `${headRefOid}..${latestBaseOid}`, localGitOptions),
      loadConflictingFiles(repoPath, mergeBase, headRefOid, latestBaseOid, localGitOptions)
    ])

    const summary = {
      baseRef: baseRefName,
      baseCommit: latestBaseOid.slice(0, 7),
      commitsBehind,
      files,
      ...(files.length === 0 ? { localMergeState: 'clean' as const } : {})
    }
    storeCachedSummary(summaryKey, summary)
    return summary
  } catch {
    storeCachedSummary(summaryKey, undefined)
    return undefined
  }
}

async function resolveMergeBase(
  repoPath: string,
  headOid: string,
  baseOid: string,
  localGitOptions: LocalGitExecOptions
): Promise<string> {
  const { stdout } = await gitExecFileAsync(['merge-base', headOid, baseOid], {
    ...gitOptionsForWorktree(repoPath, localGitOptions)
  })
  return stdout.trim()
}

async function countCommits(
  repoPath: string,
  range: string,
  localGitOptions: LocalGitExecOptions
): Promise<number> {
  const { stdout } = await gitExecFileAsync(['rev-list', '--count', range], {
    ...gitOptionsForWorktree(repoPath, localGitOptions)
  })
  return Number.parseInt(stdout.trim(), 10) || 0
}

async function loadConflictingFiles(
  repoPath: string,
  mergeBase: string,
  headOid: string,
  baseOid: string,
  localGitOptions: LocalGitExecOptions
): Promise<string[]> {
  const modernArgs = [
    'merge-tree',
    '--write-tree',
    '--name-only',
    '-z',
    '--no-messages',
    '--merge-base',
    mergeBase,
    headOid,
    baseOid
  ]
  const legacyArgs = [
    'merge-tree',
    '--write-tree',
    '--name-only',
    '-z',
    '--no-messages',
    headOid,
    baseOid
  ]

  return withLocalGitCapabilityCacheForExecution(
    { cwd: repoPath, wslDistro: localGitOptions.wslDistro },
    (capabilities) =>
      capabilities.runWithFallback(
        'merge-tree-write-tree',
        () =>
          capabilities.runWithFallback(
            'merge-tree-merge-base',
            async () => {
              try {
                const result = await gitExecFileAsync(modernArgs, {
                  ...gitOptionsForWorktree(repoPath, localGitOptions)
                })
                return parseMergeTreeNameOnlyOutput(result.stdout)
              } catch (error) {
                if (isUnsupportedMergeTreeWriteTreeError(error)) {
                  throw error
                }
                // Why: `git merge-tree --write-tree` exits 1 for conflicts but still
                // writes the useful file list; only option rejection reaches fallback.
                const stdoutFromError = getGitErrorOutput(error, 'stdout')
                if (stdoutFromError) {
                  return parseMergeTreeNameOnlyOutput(stdoutFromError)
                }
                throw error
              }
            },
            () => loadConflictingFilesWithLegacyMergeTree(repoPath, legacyArgs, localGitOptions),
            isUnsupportedMergeTreeMergeBaseError
          ),
        async () => {
          // Why: Git before 2.38 cannot derive a reliable real-merge conflict list;
          // fail closed without respawning the same rejected command every refresh.
          throw new Error('Git merge-tree --write-tree is unavailable on this execution host.')
        },
        isUnsupportedMergeTreeWriteTreeError
      )
  )
}

async function loadConflictingFilesWithLegacyMergeTree(
  repoPath: string,
  legacyArgs: string[],
  localGitOptions: LocalGitExecOptions
): Promise<string[]> {
  try {
    const result = await gitExecFileAsync(legacyArgs, {
      ...gitOptionsForWorktree(repoPath, localGitOptions)
    })
    return parseMergeTreeNameOnlyOutput(result.stdout)
  } catch (fallbackError) {
    const fallbackStdout = getGitErrorOutput(fallbackError, 'stdout')
    if (fallbackStdout) {
      return parseMergeTreeNameOnlyOutput(fallbackStdout)
    }
    throw fallbackError
  }
}

function parseMergeTreeNameOnlyOutput(stdout: string): string[] {
  const entries = stdout.split('\0').filter(Boolean)
  if (entries.length === 0) {
    return []
  }

  const [, ...files] = entries
  return files
}

function getGitErrorOutput(error: unknown, key: 'stdout' | 'stderr'): string {
  if (typeof error !== 'object' || error === null) {
    return ''
  }
  const output = (error as Partial<Record<'stdout' | 'stderr', unknown>>)[key]
  return typeof output === 'string' ? output : ''
}
