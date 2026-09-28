import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { coordinatorMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./pr-refresh-coordinator-test-mocks')
  return { coordinatorMocks: moduleMocks.createPRRefreshCoordinatorMocks(), moduleMocks }
})

vi.mock('electron', () => moduleMocks.electronModuleMock(coordinatorMocks))
vi.mock('./client', () => moduleMocks.clientModuleMock(coordinatorMocks))
vi.mock('./github-api-repository', () =>
  moduleMocks.githubApiRepositoryModuleMock(coordinatorMocks)
)
vi.mock('./rate-limit', () => moduleMocks.rateLimitModuleMock(coordinatorMocks))
vi.mock('../ipc/ui', () => moduleMocks.ipcUiModuleMock(coordinatorMocks))

const gitExecFileAsyncMock = vi.hoisted(() => vi.fn())
vi.mock('../git/runner', () => ({ gitExecFileAsync: gitExecFileAsyncMock }))

import { makeCandidate } from './pr-refresh-coordinator-test-harness'
import type { GitAdmissionTier } from '../git/command-runner/git-exec-options'

const gitOutputs: Record<string, string> = {
  'rev-parse': 'base-tip\n',
  'merge-base': 'merge-base\n',
  'rev-list': '2\n',
  'merge-tree': 'tree-oid\u0000src/conflict.ts\u0000'
}

const { getPRForBranchOutcomeMock } = coordinatorMocks

function refreshedRepoPaths(): unknown[] {
  return getPRForBranchOutcomeMock.mock.calls.map((call) => call[0])
}

describe('PR refresh queue while a worktree create is in flight', () => {
  beforeEach(() => {
    moduleMocks.resetPRRefreshCoordinatorMocks(coordinatorMocks)
    getPRForBranchOutcomeMock.mockResolvedValue({ kind: 'no-pr', fetchedAt: Date.now() })
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncMock.mockImplementation(async (argv: string[]) => ({
      stdout: gitOutputs[argv[0]] ?? ''
    }))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('defers a background refresh on the held repo without holding up other repos', async () => {
    // Imported after the per-test module reset so the drainer and the test share one registry.
    const { enqueuePRRefresh } = await import('./pr-refresh-coordinator')
    const { holdRepoForWorktreeCreate } = await import('../git/worktree-create-repo-activity')
    const release = holdRepoForWorktreeCreate({ path: '/repo' })

    enqueuePRRefresh(makeCandidate(), 'swr')
    enqueuePRRefresh(
      makeCandidate({
        repoPath: '/other',
        repoId: 'repo-2',
        worktreeId: 'wt-2',
        cacheKey: '/other::feature/test'
      }),
      'swr'
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(refreshedRepoPaths()).toEqual(['/other'])

    // Past the queue's own background spacing, so only the create hold can explain a further wait.
    await vi.advanceTimersByTimeAsync(30_000)
    expect(refreshedRepoPaths()).toEqual(['/other'])

    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(refreshedRepoPaths()).toEqual(['/other', '/repo'])
  })

  it('lets a refresh already running when a create starts finish without stalling other repos', async () => {
    const { enqueuePRRefresh } = await import('./pr-refresh-coordinator')
    const { holdRepoForWorktreeCreate } = await import('../git/worktree-create-repo-activity')
    const { getPRConflictSummary } = await import('./conflict-summary')
    let release = (): void => {}
    let summary: unknown
    getPRForBranchOutcomeMock.mockImplementation(
      async (
        repoPath: string,
        _branch: string,
        _linkedPR: number | null,
        _connectionId: string | null,
        _fallbackPR: number | null,
        options?: { localGitExecOptions?: { admissionTier?: GitAdmissionTier } }
      ) => {
        if (repoPath === '/repo') {
          // The create begins after this background refresh has already started.
          release = holdRepoForWorktreeCreate({ path: '/repo' })
          summary = await getPRConflictSummary(
            '/repo',
            'main',
            'github-base-oid',
            'head-oid',
            options?.localGitExecOptions
          )
        }
        return { kind: 'no-pr', fetchedAt: Date.now() }
      }
    )

    enqueuePRRefresh(makeCandidate(), 'swr')
    enqueuePRRefresh(
      makeCandidate({
        repoPath: '/other',
        repoId: 'repo-2',
        worktreeId: 'wt-2',
        cacheKey: '/other::feature/test'
      }),
      'swr'
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(summary).toMatchObject({ files: ['src/conflict.ts'] })

    // One background spacing later, well inside the create deadline.
    await vi.advanceTimersByTimeAsync(15_000)
    expect(refreshedRepoPaths()).toEqual(['/repo', '/other'])
    release()
  })

  it('runs a manual refresh on the held repo immediately', async () => {
    const { enqueuePRRefresh } = await import('./pr-refresh-coordinator')
    const { holdRepoForWorktreeCreate } = await import('../git/worktree-create-repo-activity')
    const release = holdRepoForWorktreeCreate({ path: '/repo' })

    enqueuePRRefresh(makeCandidate(), 'manual')
    await vi.advanceTimersByTimeAsync(0)
    expect(refreshedRepoPaths()).toEqual(['/repo'])
    release()
  })

  it('promotes a deferred background refresh when the user asks for it', async () => {
    const { enqueuePRRefresh } = await import('./pr-refresh-coordinator')
    const { holdRepoForWorktreeCreate } = await import('../git/worktree-create-repo-activity')
    const release = holdRepoForWorktreeCreate({ path: '/repo' })

    enqueuePRRefresh(makeCandidate(), 'swr')
    await vi.advanceTimersByTimeAsync(0)
    expect(refreshedRepoPaths()).toEqual([])

    enqueuePRRefresh(makeCandidate(), 'manual')
    await vi.advanceTimersByTimeAsync(0)
    expect(refreshedRepoPaths()).toEqual(['/repo'])
    release()
  })

  it('runs a deferred refresh at the deadline even while creates keep the repo held', async () => {
    const { enqueuePRRefresh } = await import('./pr-refresh-coordinator')
    const { holdRepoForWorktreeCreate, WORKTREE_CREATE_IDLE_WAIT_DEADLINE_MS } =
      await import('../git/worktree-create-repo-activity')
    const release = holdRepoForWorktreeCreate({ path: '/repo' })

    enqueuePRRefresh(makeCandidate(), 'swr')
    await vi.advanceTimersByTimeAsync(WORKTREE_CREATE_IDLE_WAIT_DEADLINE_MS - 1_000)
    expect(refreshedRepoPaths()).toEqual([])

    await vi.advanceTimersByTimeAsync(2_000)
    expect(refreshedRepoPaths()).toEqual(['/repo'])
    release()
  })
})
