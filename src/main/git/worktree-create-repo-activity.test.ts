import { afterEach, describe, expect, it } from 'vitest'
import {
  _resetWorktreeCreateRepoActivityForTests,
  hasWorktreeCreatesInFlight,
  holdRepoForWorktreeCreate,
  isWorktreeCreateInFlight
} from './worktree-create-repo-activity'
import { runLocalWorktreeCreate } from './worktree-create-git-executor'
import { resolveGitAdmissionTier } from './command-runner/git-operation-executor'

const REPO = { path: '/repos/app' }
const OTHER_REPO = { path: '/repos/other' }

afterEach(() => {
  _resetWorktreeCreateRepoActivityForTests()
})

describe('worktree create repo activity', () => {
  it('counts overlapping holds and treats a repeated release as a no-op', () => {
    const first = holdRepoForWorktreeCreate(REPO)
    const second = holdRepoForWorktreeCreate(REPO)
    first()
    first()
    expect(isWorktreeCreateInFlight(REPO.path)).toBe(true)
    second()
    expect(isWorktreeCreateInFlight(REPO.path)).toBe(false)
    expect(hasWorktreeCreatesInFlight()).toBe(false)
  })

  it('names the repo by its root path regardless of trailing-slash spelling', () => {
    const release = holdRepoForWorktreeCreate({ path: '/repos/app/' })
    expect(isWorktreeCreateInFlight('/repos/app')).toBe(true)
    release()
  })

  it('holds only the repo being created in', () => {
    const release = holdRepoForWorktreeCreate(REPO)
    expect(isWorktreeCreateInFlight(OTHER_REPO.path)).toBe(false)
    expect(hasWorktreeCreatesInFlight()).toBe(true)
    release()
  })

  it('runs git inside the create at the interactive tier', async () => {
    let tierDuringCreate: string | undefined
    await runLocalWorktreeCreate(REPO, async () => {
      tierDuringCreate = resolveGitAdmissionTier()
    })
    expect(tierDuringCreate).toBe('interactive')
    // Why: detached work after the create must not keep its priority.
    expect(resolveGitAdmissionTier()).toBe('status')
  })

  it.each([
    ['succeeds', async () => 'ok'],
    [
      'throws',
      async () => {
        throw new Error('worktree add failed')
      }
    ]
  ])('releases the hold when the create %s', async (_label, operation) => {
    let heldDuringCreate = false
    const create = runLocalWorktreeCreate(REPO, async () => {
      heldDuringCreate = isWorktreeCreateInFlight(REPO.path)
      return operation()
    })
    await create.catch(() => {})
    expect(heldDuringCreate).toBe(true)
    expect(isWorktreeCreateInFlight(REPO.path)).toBe(false)
  })

  it('releases the hold when the create is cancelled', async () => {
    const controller = new AbortController()
    const create = runLocalWorktreeCreate(REPO, async () => {
      await new Promise<void>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('cancelled')))
      })
    })
    expect(isWorktreeCreateInFlight(REPO.path)).toBe(true)
    controller.abort()
    await expect(create).rejects.toThrow('cancelled')
    expect(isWorktreeCreateInFlight(REPO.path)).toBe(false)
  })
})
