import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({ gitExecFileAsyncMock: vi.fn() }))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  translateWslOutputPaths: (output: string) => output
}))

import { refreshLocalBaseRefForWorktreeCreate } from './worktree-base-refresh'

const INDEX_LOCK_ERROR = Object.assign(new Error('Command failed: git reset --hard remote-main'), {
  stderr:
    "fatal: Unable to create '/repo/.git/index.lock': File exists.\n\nAnother git process seems to be running in this repository"
})
const OWNER_WORKTREE_LIST = 'worktree /repo\nHEAD old-main\nbranch refs/heads/main\n'

type GitFake = {
  owner?: boolean
  mutate: () => Promise<{ stdout: string }>
  localOidAfterFailure?: () => string
}

function installGitFake(fake: GitFake): void {
  let localRefReads = 0
  gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    const [command] = args
    if (command === 'rev-list') {
      return { stdout: '0\t3\n' }
    }
    if (command === 'rev-parse' && args[2] === 'refs/heads/main^{commit}') {
      localRefReads += 1
      return {
        stdout: `${localRefReads === 1 ? 'old-main' : (fake.localOidAfterFailure?.() ?? 'old-main')}\n`
      }
    }
    if (command === 'rev-parse') {
      return { stdout: 'remote-main\n' }
    }
    if (command === 'merge-base' || command === 'status') {
      return { stdout: '' }
    }
    if (command === 'worktree') {
      return { stdout: fake.owner ? OWNER_WORKTREE_LIST : '' }
    }
    if (command === 'reset' || command === 'update-ref') {
      return fake.mutate()
    }
    throw new Error(`unexpected git ${args.join(' ')}`)
  })
}

function refresh() {
  return refreshLocalBaseRefForWorktreeCreate('/repo', 'origin/main', 'refs/remotes/origin/main')
}

function mutationCalls(): string[][] {
  return gitExecFileAsyncMock.mock.calls
    .map(([args]) => args as string[])
    .filter(([command]) => command === 'reset' || command === 'update-ref')
}

describe('refreshLocalBaseRefForWorktreeCreate lock contention', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    gitExecFileAsyncMock.mockReset()
  })
  afterEach(() => vi.useRealTimers())

  it('retries a reset that lost the index.lock race and reports updated', async () => {
    const mutate = vi
      .fn()
      .mockRejectedValueOnce(INDEX_LOCK_ERROR)
      .mockResolvedValueOnce({ stdout: '' })
    installGitFake({ owner: true, mutate })

    const pending = refresh()
    await vi.runAllTimersAsync()

    await expect(pending).resolves.toEqual({
      baseRef: 'origin/main',
      localBranch: 'main',
      status: 'updated',
      ownerWorktreePath: '/repo'
    })
    expect(mutationCalls()).toEqual([
      ['reset', '--hard', 'remote-main'],
      ['reset', '--hard', 'remote-main']
    ])
  })

  it('re-checks owner cleanliness before each retry', async () => {
    const mutate = vi.fn().mockRejectedValue(INDEX_LOCK_ERROR)
    installGitFake({ owner: true, mutate })
    let statusReads = 0
    const base = gitExecFileAsyncMock.getMockImplementation()!
    gitExecFileAsyncMock.mockImplementation(async (args: string[], opts: unknown) => {
      if (args[0] === 'status') {
        statusReads += 1
        // Evaluation and the first attempt see a clean owner; it is dirty by the retry.
        return { stdout: statusReads >= 3 ? ' M file.ts\n' : '' }
      }
      return base(args, opts)
    })

    const pending = refresh()
    await vi.runAllTimersAsync()

    await expect(pending).resolves.toMatchObject({ status: 'skipped_dirty_worktree' })
    expect(mutationCalls()).toHaveLength(1)
  })

  it('reports updated without a warning when the lock never clears but local already reached the target', async () => {
    let failures = 0
    installGitFake({
      owner: true,
      mutate: async () => {
        failures += 1
        throw INDEX_LOCK_ERROR
      },
      // The concurrent holder finishes its fast-forward while our retries are waiting.
      localOidAfterFailure: () => (failures >= 4 ? 'remote-main' : 'old-main')
    })

    const pending = refresh()
    await vi.runAllTimersAsync()

    await expect(pending).resolves.toMatchObject({ status: 'updated' })
    expect(mutationCalls()).toHaveLength(4)
  })

  it('reports skipped_error when the lock never clears and local is still behind', async () => {
    installGitFake({ owner: true, mutate: () => Promise.reject(INDEX_LOCK_ERROR) })

    const pending = refresh()
    await vi.runAllTimersAsync()

    await expect(pending).resolves.toMatchObject({ status: 'skipped_error' })
    expect(mutationCalls()).toHaveLength(4)
  })

  it('does not retry a failure that is not lock contention', async () => {
    const casMismatch = Object.assign(new Error('Command failed: git update-ref'), {
      stderr: "fatal: cannot lock ref 'refs/heads/main': is at other-oid but expected old-main"
    })
    installGitFake({ mutate: () => Promise.reject(casMismatch) })

    const pending = refresh()
    await vi.runAllTimersAsync()

    await expect(pending).resolves.toMatchObject({ status: 'skipped_error' })
    expect(mutationCalls()).toEqual([['update-ref', 'refs/heads/main', 'remote-main', 'old-main']])
  })

  it('treats a lost update-ref race as success when someone else moved local to the target', async () => {
    const casMismatch = Object.assign(new Error('Command failed: git update-ref'), {
      stderr: "fatal: cannot lock ref 'refs/heads/main': is at remote-main but expected old-main"
    })
    installGitFake({
      mutate: () => Promise.reject(casMismatch),
      localOidAfterFailure: () => 'remote-main'
    })

    await expect(refresh()).resolves.toEqual({
      baseRef: 'origin/main',
      localBranch: 'main',
      status: 'updated'
    })
    expect(mutationCalls()).toHaveLength(1)
  })

  it('skips the owner check and reset when local is already current', async () => {
    installGitFake({ owner: true, mutate: () => Promise.resolve({ stdout: '' }) })
    const base = gitExecFileAsyncMock.getMockImplementation()!
    gitExecFileAsyncMock.mockImplementation(async (args: string[], opts: unknown) =>
      args[0] === 'rev-list' ? { stdout: '0\t0\n' } : base(args, opts)
    )

    await expect(refresh()).resolves.toBeUndefined()
    expect(gitExecFileAsyncMock.mock.calls.map(([args]) => args[0])).toEqual(['rev-list'])
  })
})
