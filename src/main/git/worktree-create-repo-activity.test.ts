import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  _resetWorktreeCreateRepoActivityForTests,
  hasWorktreeCreatesInFlight,
  holdRepoForWorktreeCreate,
  isWorktreeCreateInFlight,
  waitForWorktreeCreateIdle,
  WORKTREE_CREATE_IDLE_WAIT_DEADLINE_MS
} from './worktree-create-repo-activity'
import { runLocalWorktreeCreate } from './worktree-create-git-executor'

const REPO = { path: '/repos/app' }
const OTHER_REPO = { path: '/repos/other' }

function trackSettled(promise: Promise<void>): { settled: () => boolean } {
  let settled = false
  void promise.then(() => {
    settled = true
  })
  return { settled: () => settled }
}

afterEach(() => {
  vi.useRealTimers()
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

  it('resolves an idle wait immediately when nothing holds the repo', async () => {
    await expect(waitForWorktreeCreateIdle(REPO.path)).resolves.toBeUndefined()
  })

  it('resolves an idle wait when the last hold is released', async () => {
    const release = holdRepoForWorktreeCreate(REPO)
    const wait = trackSettled(waitForWorktreeCreateIdle(REPO.path))
    await Promise.resolve()
    expect(wait.settled()).toBe(false)
    release()
    await vi.waitFor(() => expect(wait.settled()).toBe(true))
  })

  it('waits for both of two concurrent creates on one repo', async () => {
    const first = holdRepoForWorktreeCreate(REPO)
    const second = holdRepoForWorktreeCreate(REPO)
    const wait = trackSettled(waitForWorktreeCreateIdle(REPO.path))
    first()
    await Promise.resolve()
    expect(wait.settled()).toBe(false)
    second()
    await vi.waitFor(() => expect(wait.settled()).toBe(true))
  })

  it('resolves at the deadline while creates keep the repo continuously held', async () => {
    vi.useFakeTimers()
    let release = holdRepoForWorktreeCreate(REPO)
    const wait = trackSettled(waitForWorktreeCreateIdle(REPO.path))
    // Back-to-back creates: the next one starts before the previous one ends.
    for (let i = 0; i < 3; i += 1) {
      const next = holdRepoForWorktreeCreate(REPO)
      release()
      release = next
      await vi.advanceTimersByTimeAsync(WORKTREE_CREATE_IDLE_WAIT_DEADLINE_MS / 4)
      expect(wait.settled()).toBe(false)
    }
    await vi.advanceTimersByTimeAsync(WORKTREE_CREATE_IDLE_WAIT_DEADLINE_MS / 4)
    expect(wait.settled()).toBe(true)
    expect(isWorktreeCreateInFlight(REPO.path)).toBe(true)
    release()
  })

  it('does not delay work on a different repo', async () => {
    const release = holdRepoForWorktreeCreate(REPO)
    await expect(waitForWorktreeCreateIdle(OTHER_REPO.path)).resolves.toBeUndefined()
    release()
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
