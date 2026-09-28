import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Why these tests exist: every background base fetch that moves the tip
// re-derives every conflicting PR (fetch + merge-base + rev-list + merge-tree).
// While a worktree create runs in the repo, background refreshes reuse the last
// tip instead, so none of that competes with the create; user-driven lookups
// still fetch, and nothing waits on the create.

const gitExecFileAsyncMock = vi.hoisted(() => vi.fn())

vi.mock('../git/runner', () => ({ gitExecFileAsync: gitExecFileAsyncMock }))

import { CONFLICT_SUMMARY_BASE_FETCH_WINDOW_MS } from './conflict-summary-cache'
import { __resetPRConflictSummaryCachesForTests, getPRConflictSummary } from './conflict-summary'
import { derivePRRefreshData } from './client/lookup/branch-lookup-derived-data'
import type { GitAdmissionTier } from '../git/command-runner/git-exec-options'
import {
  _resetWorktreeCreateRepoActivityForTests,
  holdRepoForWorktreeCreate
} from '../git/worktree-create-repo-activity'
import { runLocalWorktreeCreate } from '../git/worktree-create-git-executor'

type GitResult = { stdout: string }
type GitHandler = (argv: string[]) => Promise<GitResult>

const REPO_PATH = '/repo-root'
const START = 1_750_000_000_000
const PAST_FETCH_WINDOW = CONFLICT_SUMMARY_BASE_FETCH_WINDOW_MS + 1_000
const PAST_CREATE_TIP_CAP = 5 * 60_000 + 1_000

const defaultHandlers: Record<string, GitHandler> = {
  fetch: async () => ({ stdout: '' }),
  'rev-parse': async () => ({ stdout: 'base-tip-1\n' }),
  'merge-base': async () => ({ stdout: 'merge-base-1\n' }),
  'rev-list': async () => ({ stdout: '3\n' }),
  'merge-tree': async () => ({ stdout: 'tree-oid\u0000src/conflict.ts\u0000' })
}

function mockGitDispatch(overrides: Record<string, GitHandler> = {}): void {
  gitExecFileAsyncMock.mockImplementation((argv: string[]) => {
    const handler = overrides[argv[0]] ?? defaultHandlers[argv[0]]
    if (!handler) {
      return Promise.reject(new Error(`unexpected git command: ${argv.join(' ')}`))
    }
    return handler(argv)
  })
}

function spawnCount(command?: string): number {
  const calls = gitExecFileAsyncMock.mock.calls
  return command ? calls.filter(([argv]) => argv[0] === command).length : calls.length
}

function neverSettlingFetch(): Promise<GitResult> {
  return new Promise<GitResult>(() => {})
}

const expectedSummary = {
  baseRef: 'main',
  baseCommit: 'base-ti',
  commitsBehind: 3,
  files: ['src/conflict.ts']
}

function deriveSummary(admissionTier?: GitAdmissionTier) {
  return getPRConflictSummary(
    REPO_PATH,
    'main',
    'github-base-oid',
    'head-oid-1',
    admissionTier ? { admissionTier } : {}
  )
}

describe('getPRConflictSummary while a worktree create holds the repo', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(START)
    gitExecFileAsyncMock.mockReset()
    __resetPRConflictSummaryCachesForTests()
    mockGitDispatch()
  })

  afterEach(() => {
    _resetWorktreeCreateRepoActivityForTests()
    vi.useRealTimers()
  })

  it('reuses the last base tip for a background refresh and spawns no git', async () => {
    await deriveSummary('background')
    const spawnsBeforeCreate = spawnCount()
    holdRepoForWorktreeCreate({ path: REPO_PATH })
    vi.setSystemTime(START + PAST_FETCH_WINDOW)
    // A fetch now would move the tip and re-derive the whole chain.
    mockGitDispatch({ 'rev-parse': async () => ({ stdout: 'base-tip-2\n' }) })

    await expect(deriveSummary('background')).resolves.toEqual(expectedSummary)
    expect(spawnCount()).toBe(spawnsBeforeCreate)
  })

  it('still fetches for an interactive refresh', async () => {
    await deriveSummary('background')
    holdRepoForWorktreeCreate({ path: REPO_PATH })
    vi.setSystemTime(START + PAST_FETCH_WINDOW)

    await deriveSummary('interactive')
    expect(spawnCount('fetch')).toBe(2)
  })

  it("still fetches for the create's own lookup, which inherits the interactive tier", async () => {
    await deriveSummary('background')
    const repo = { path: REPO_PATH }
    vi.setSystemTime(START + PAST_FETCH_WINDOW)

    await runLocalWorktreeCreate(repo, () => deriveSummary())
    expect(spawnCount('fetch')).toBe(2)
  })

  it('reads the local remote-tracking tip on a cold cache without fetching or caching it', async () => {
    const release = holdRepoForWorktreeCreate({ path: REPO_PATH })

    await expect(deriveSummary('background')).resolves.toEqual(expectedSummary)
    expect(spawnCount('fetch')).toBe(0)
    expect(spawnCount('rev-parse')).toBe(1)

    release()
    await deriveSummary('background')
    expect(spawnCount('fetch')).toBe(1)
  })

  it('fetches again for the first background refresh after the create settles', async () => {
    await deriveSummary('background')
    const release = holdRepoForWorktreeCreate({ path: REPO_PATH })
    vi.setSystemTime(START + PAST_FETCH_WINDOW)
    await deriveSummary('background')
    expect(spawnCount('fetch')).toBe(1)

    release()
    await deriveSummary('background')
    expect(spawnCount('fetch')).toBe(2)
  })

  it('fetches when the last tip is older than the create cap', async () => {
    await deriveSummary('background')
    holdRepoForWorktreeCreate({ path: REPO_PATH })
    vi.setSystemTime(START + PAST_CREATE_TIP_CAP)

    await deriveSummary('background')
    expect(spawnCount('fetch')).toBe(2)
  })

  it('never hands a skipped fetch to a concurrent interactive caller', async () => {
    await deriveSummary('background')
    holdRepoForWorktreeCreate({ path: REPO_PATH })
    vi.setSystemTime(START + PAST_FETCH_WINDOW)
    let releaseFetch: ((value: GitResult) => void) | undefined
    mockGitDispatch({
      fetch: () =>
        new Promise<GitResult>((resolve) => {
          releaseFetch = resolve
        }),
      'rev-parse': async () => ({ stdout: 'base-tip-2\n' })
    })

    const background = deriveSummary('background')
    const interactive = deriveSummary('interactive')
    // The background caller neither joins nor waits on the interactive fetch.
    await expect(background).resolves.toEqual(expectedSummary)
    await vi.waitFor(() => expect(spawnCount('fetch')).toBe(2))

    releaseFetch?.({ stdout: '' })
    await expect(interactive).resolves.toEqual(expectedSummary)
    expect(
      gitExecFileAsyncMock.mock.calls.some(
        ([argv]) => argv[0] === 'merge-base' && argv.includes('base-tip-2')
      )
    ).toBe(true)
  })

  it('keeps the card lookup path off the fetch while the repo is held', async () => {
    // What `hostedReview:forBranch` passes when the card poll names no tier.
    const localGitOptions: { wslDistro?: string; admissionTier: GitAdmissionTier } = {
      admissionTier: 'background'
    }
    const lookup = () =>
      derivePRRefreshData({
        data: {
          number: 7,
          title: 'Feature',
          state: 'OPEN',
          url: 'https://github.com/acme/app/pull/7',
          statusCheckRollup: [],
          updatedAt: '2026-09-28T00:00:00Z',
          mergeable: 'CONFLICTING',
          baseRefName: 'main',
          baseRefOid: 'github-base-oid',
          headRefOid: 'head-oid-1',
          stackMetadataChecked: true
        },
        dataRepo: null,
        repoPath: REPO_PATH,
        connectionId: null,
        localGitOptions,
        ghOptions: { cwd: REPO_PATH },
        executionScope: 'local',
        usedExactNumberLookup: true
      })
    const beforeCreate = await lookup()
    holdRepoForWorktreeCreate({ path: REPO_PATH })
    vi.setSystemTime(START + PAST_FETCH_WINDOW)
    mockGitDispatch({ fetch: neverSettlingFetch })

    // Resolves without advancing timers: nothing on this path waits on the create.
    const duringCreate = await lookup()
    expect(duringCreate.conflictSummary).toEqual(beforeCreate.conflictSummary)
    expect(duringCreate.conflictSummary).toEqual(expectedSummary)
    expect(spawnCount('fetch')).toBe(1)
  })
})
