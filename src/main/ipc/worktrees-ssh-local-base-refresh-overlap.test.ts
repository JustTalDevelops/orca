import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getSshGitProviderMock, getActiveMultiplexerMock } from './worktrees-test-module-mocks'
import { handlers, setupWorktreeHandlers, store } from './worktrees-test-harness'

vi.mock('electron', async () =>
  (await import('./worktrees-test-module-mocks')).electronModuleMock()
)
vi.mock('../git/worktree', async () =>
  (await import('./worktrees-test-module-mocks')).gitWorktreeModuleMock()
)
vi.mock('../git/runner', async () =>
  (await import('./worktrees-test-module-mocks')).gitRunnerModuleMock()
)
vi.mock('../git/repo', async () =>
  (await import('./worktrees-test-module-mocks')).gitRepoModuleMock()
)
vi.mock('../git/git-username', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveLocalGitUsername: (await import('./worktrees-test-module-mocks'))
    .resolveLocalGitUsernameMock
}))
vi.mock('../github/client', async () =>
  (await import('./worktrees-test-module-mocks')).githubClientModuleMock()
)
vi.mock('../source-control/hosted-review', async () =>
  (await import('./worktrees-test-module-mocks')).hostedReviewModuleMock()
)
vi.mock('../providers/ssh-git-dispatch', async () =>
  (await import('./worktrees-test-module-mocks')).sshGitDispatchModuleMock()
)
vi.mock('../providers/ssh-filesystem-dispatch', async () =>
  (await import('./worktrees-test-module-mocks')).sshFilesystemDispatchModuleMock()
)
vi.mock('./worktree-symlinks', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeSymlinksModuleMock()
)
vi.mock('./ssh', async () => (await import('./worktrees-test-module-mocks')).sshModuleMock())
vi.mock('../ssh/ssh-target-registry', async () =>
  (await import('./worktrees-test-module-mocks')).sshTargetRegistryModuleMock()
)
vi.mock('../hooks', async () => (await import('./worktrees-test-module-mocks')).hooksModuleMock())
vi.mock('../setup-runner-script-text', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).setupRunnerScriptTextModuleMock(
    await importOriginal<Record<string, unknown>>()
  )
)
vi.mock('../worktree-runner-script', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).worktreeRunnerScriptModuleMock(
    await importOriginal<Record<string, unknown>>()
  )
)
vi.mock('../effective-hook-config', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).effectiveHookConfigModuleMock(
    await importOriginal<Record<string, unknown>>()
  )
)
vi.mock('../setup-hook-env-vars', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).setupHookEnvVarsModuleMock(
    await importOriginal<Record<string, unknown>>()
  )
)
vi.mock('./worktree-logic', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).worktreeLogicModuleMock(
    await importOriginal<Record<string, unknown>>()
  )
)
vi.mock('../terminal-history-deletion', async () =>
  (await import('./worktrees-test-module-mocks')).terminalHistoryDeletionModuleMock()
)
vi.mock('../ports/advertised-url-watcher', async () =>
  (await import('./worktrees-test-module-mocks')).advertisedUrlWatcherModuleMock()
)
vi.mock('../workspace-cleanup-scan-snapshot', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceCleanupScanSnapshotModuleMock()
)
vi.mock('../workspace-space-analysis-snapshot', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceSpaceAnalysisSnapshotModuleMock()
)
vi.mock('../workspace-cleanup-removal-snapshot-prune', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceCleanupRemovalSnapshotPruneModuleMock()
)
vi.mock('../runtime/worktree-teardown', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeTeardownModuleMock()
)
vi.mock('./pty', async () => (await import('./worktrees-test-module-mocks')).ptyModuleMock())

const REPO = {
  id: 'repo-ssh',
  path: '/remote/repo',
  displayName: 'ssh',
  badgeColor: '#000',
  addedAt: 0,
  connectionId: 'conn-1',
  worktreeBaseRef: 'origin/main'
}
const INDEX_LOCK_ERROR = new Error(
  "Command failed: git reset --hard abc\nfatal: Unable to create '/remote/repo/.git/index.lock': File exists."
)

function createProvider(overrides: {
  refreshLocalBaseRefForWorktreeCreate: ReturnType<typeof vi.fn>
  localOid?: () => string
  addWorktree?: ReturnType<typeof vi.fn>
}) {
  return {
    exec: vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote') {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args[0] === 'show-ref') {
        throw Object.assign(new Error('missing remote ref'), { code: 1 })
      }
      if (args[0] === 'log') {
        return { stdout: 'commit-a\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args[1] === 'refs/heads/main^{commit}') {
        return { stdout: `${overrides.localOid?.() ?? 'old-main'}\nremote-main\n`, stderr: '' }
      }
      return { stdout: '', stderr: '' }
    }),
    fetchRemoteTrackingRef: vi.fn().mockResolvedValue(undefined),
    addWorktree: overrides.addWorktree ?? vi.fn().mockResolvedValue(undefined),
    listWorktrees: vi
      .fn()
      .mockResolvedValueOnce([
        {
          path: '/remote/repo',
          head: 'old-main',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        }
      ])
      .mockResolvedValueOnce([
        {
          path: '/remote/repo-improve-dashboard',
          head: 'remote-main',
          branch: 'refs/heads/improve-dashboard',
          isBare: false,
          isMainWorktree: false
        }
      ]),
    worktreeIsClean: vi.fn().mockResolvedValue({ clean: true }),
    refreshLocalBaseRefForWorktreeCreate: overrides.refreshLocalBaseRefForWorktreeCreate
  }
}

async function createWith(
  provider: ReturnType<typeof createProvider>,
  request: { repo?: typeof REPO; name?: string } = {}
) {
  const repo = request.repo ?? REPO
  store.getSettings.mockReturnValue({
    branchPrefix: 'none',
    nestWorkspaces: false,
    refreshLocalBaseRefOnWorktreeCreate: true,
    workspaceDir: '/workspace'
  })
  store.getRepos.mockReturnValue([repo])
  store.getRepo.mockReturnValue(repo)
  getSshGitProviderMock.mockReturnValue(provider)
  getActiveMultiplexerMock.mockReturnValue({
    request: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn()
  })
  store.setWorktreeMeta.mockImplementation((_worktreeId, meta) => meta)
  const result: unknown = await handlers['worktrees:create'](null, {
    repoId: 'repo-ssh',
    name: request.name ?? 'improve-dashboard'
  })
  return result
}

const UPDATED = {
  status: 'updated',
  baseRef: 'origin/main',
  localBranch: 'main',
  ownerWorktreePath: '/remote/repo'
}

describe('SSH local base refresh under lock contention', () => {
  beforeEach(() => {
    setupWorktreeHandlers()
  })

  it('retries the relay refresh after an index.lock failure', async () => {
    const refresh = vi.fn().mockRejectedValueOnce(INDEX_LOCK_ERROR).mockResolvedValueOnce(undefined)

    const result = await createWith(
      createProvider({ refreshLocalBaseRefForWorktreeCreate: refresh })
    )

    expect(refresh).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ localBaseRefRefresh: UPDATED })
  })

  it('reports updated, not a warning, when local already reached the remote-tracking commit', async () => {
    const refresh = vi.fn().mockRejectedValue(INDEX_LOCK_ERROR)

    const result = await createWith(
      createProvider({
        refreshLocalBaseRefForWorktreeCreate: refresh,
        localOid: () => 'remote-main'
      })
    )

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ localBaseRefRefresh: UPDATED })
  })

  it('does not retry a relay refusal that is not lock contention', async () => {
    const refresh = vi
      .fn()
      .mockRejectedValue(new Error('Local base ref worktree has tracked changes.'))

    const result = await createWith(
      createProvider({ refreshLocalBaseRefForWorktreeCreate: refresh })
    )

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ localBaseRefRefresh: { status: 'skipped_error' } })
  })

  // #15331: `-b feature-x` proves there was no local feature-x to refresh; probing it would race the relay add.
  it('does not probe or warn when the create makes the local base branch itself', async () => {
    let markAdded!: () => void
    const added = new Promise<void>((resolve) => (markAdded = resolve))
    const provider = createProvider({
      refreshLocalBaseRefForWorktreeCreate: vi.fn(),
      addWorktree: vi.fn(async () => markAdded())
    })
    provider.exec.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote') {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args[0] === 'merge-base') {
        // Without the skip, the presence probe after this lands once the add wrote refs/heads/feature-x.
        await added
        throw new Error('fatal: Not a valid object name refs/heads/feature-x')
      }
      if (args[0] === 'show-ref') {
        return { stdout: '', stderr: '' }
      }
      const ref = args.at(-1) ?? ''
      return { stdout: ref.startsWith('refs/heads/') ? '' : 'remote-x\n', stderr: '' }
    })
    provider.listWorktrees
      .mockReset()
      .mockResolvedValue([
        { path: '/remote/repo-feature-x', head: 'remote-x', branch: 'refs/heads/feature-x' }
      ])

    const result = await createWith(provider, {
      repo: { ...REPO, worktreeBaseRef: 'origin/feature-x' },
      name: 'feature-x'
    })

    expect(provider.addWorktree).toHaveBeenCalledTimes(1)
    expect(result).not.toHaveProperty('localBaseRefRefresh')
    expect(provider.exec.mock.calls.map(([args]) => args[0])).not.toContain('merge-base')
  })

  it('starts the relay worktree add while the refresh is still running', async () => {
    let finishRefresh!: () => void
    let markRefreshStarted!: () => void
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve
    })
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRefresh = resolve
          markRefreshStarted()
        })
    )
    // Would deadlock if create awaited the refresh before starting the add.
    const addWorktree = vi.fn(async () => {
      await refreshStarted
      finishRefresh()
    })

    const result = await createWith(
      createProvider({ refreshLocalBaseRefForWorktreeCreate: refresh, addWorktree })
    )

    expect(addWorktree).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ localBaseRefRefresh: UPDATED })
  })
})

describe('SSH local base refresh queue', () => {
  beforeEach(() => {
    setupWorktreeHandlers()
  })

  // One provider per connection; every list includes the owner checkout and each created worktree.
  function startConcurrentCreates(
    requests: { repo: typeof REPO; name: string }[],
    refresh: ReturnType<typeof vi.fn>
  ) {
    const providers = new Map<string, ReturnType<typeof createProvider>>()
    for (const { repo } of requests) {
      if (!providers.has(repo.connectionId)) {
        const provider = createProvider({ refreshLocalBaseRefForWorktreeCreate: refresh })
        provider.listWorktrees.mockReset().mockResolvedValue([
          { path: repo.path, head: 'old-main', branch: 'refs/heads/main', isMainWorktree: true },
          ...requests.map(({ repo: r, name }) => ({
            path: `${r.path}-${name}`,
            head: 'remote-main',
            branch: `refs/heads/${name}`
          }))
        ])
        providers.set(repo.connectionId, provider)
      }
    }
    store.getSettings.mockReturnValue({
      branchPrefix: 'none',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: true,
      workspaceDir: '/workspace'
    })
    store.getRepos.mockReturnValue(requests.map(({ repo }) => repo))
    store.getRepo.mockImplementation((id: string) => requests.find((r) => r.repo.id === id)?.repo)
    getSshGitProviderMock.mockImplementation((connectionId: string) => providers.get(connectionId))
    getActiveMultiplexerMock.mockReturnValue({
      request: vi.fn().mockResolvedValue(undefined),
      notify: vi.fn()
    })
    store.setWorktreeMeta.mockImplementation((_worktreeId, meta) => meta)
    const results = requests.map(({ repo, name }) =>
      handlers['worktrees:create'](null, { repoId: repo.id, name })
    )
    const addCalls = () =>
      [...providers.values()].reduce((sum, p) => sum + p.addWorktree.mock.calls.length, 0)
    return { results, addCalls }
  }

  function deferredRefresh() {
    const settlers: (() => void)[] = []
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settlers.push(resolve)
        })
    )
    return { refresh, settle: (index: number) => settlers[index]() }
  }

  it('starts a second relay refresh of the same repo only after the first has settled', async () => {
    const { refresh, settle } = deferredRefresh()
    const { results, addCalls } = startConcurrentCreates(
      [
        { repo: REPO, name: 'improve-dashboard' },
        { repo: REPO, name: 'fix-login' }
      ],
      refresh
    )

    // Both adds ran, so the second create is past the point where it starts its refresh.
    await vi.waitFor(() => expect(addCalls()).toBe(2))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(refresh).toHaveBeenCalledTimes(1)

    settle(0)
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2))
    settle(1)
    for (const result of await Promise.all(results)) {
      expect(result).toMatchObject({ localBaseRefRefresh: UPDATED })
    }
  })

  it('does not make refreshes of other repos or connections wait', async () => {
    const { refresh, settle } = deferredRefresh()
    const { results } = startConcurrentCreates(
      [
        { repo: REPO, name: 'improve-dashboard' },
        { repo: { ...REPO, id: 'repo-ssh-other', path: '/remote/other' }, name: 'fix-login' },
        { repo: { ...REPO, id: 'repo-ssh-conn-2', connectionId: 'conn-2' }, name: 'add-search' }
      ],
      refresh
    )

    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(3))
    ;[0, 1, 2].forEach(settle)
    await Promise.all(results)
  })
})
