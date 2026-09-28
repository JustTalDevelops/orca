import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as gitRunner from './runner'
import { refreshLocalBaseRefForWorktreeCreate } from './worktree-base-refresh'

const tempRoots: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  }).trim()
}

// Primary checkout on `main` one commit behind `refs/remotes/origin/main`, with its index locked.
async function createBehindRepoWithIndexLock(): Promise<{
  repoPath: string
  lockPath: string
  remoteOid: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'orca-base-refresh-lock-'))
  tempRoots.push(root)
  const repoPath = join(root, 'repo')
  execFileSync('git', ['init', '--quiet', repoPath])
  git(repoPath, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repoPath, ['config', 'user.email', 'test@example.com'])
  git(repoPath, ['config', 'user.name', 'Test User'])
  git(repoPath, ['config', 'core.autocrlf', 'false'])
  await writeFile(join(repoPath, 'version.txt'), 'one\n')
  git(repoPath, ['add', 'version.txt'])
  git(repoPath, ['commit', '--quiet', '-m', 'one'])
  git(repoPath, ['checkout', '--quiet', '-b', 'upstream'])
  await writeFile(join(repoPath, 'version.txt'), 'two\n')
  git(repoPath, ['commit', '--quiet', '-am', 'two'])
  const remoteOid = git(repoPath, ['rev-parse', 'HEAD'])
  git(repoPath, ['checkout', '--quiet', 'main'])
  git(repoPath, ['update-ref', 'refs/remotes/origin/main', remoteOid])
  git(repoPath, ['branch', '--quiet', '-D', 'upstream'])
  const lockPath = join(repoPath, '.git', 'index.lock')
  await writeFile(lockPath, '')
  return { repoPath, lockPath, remoteOid }
}

function spyOnFailedResets(onFailure: () => Promise<void> | void): { resets: () => number } {
  const original = gitRunner.gitExecFileAsync
  let resets = 0
  vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args, options) => {
    if (args[0] !== 'reset') {
      return original(args, options)
    }
    resets += 1
    try {
      return await original(args, options)
    } catch (error) {
      await onFailure()
      throw error
    }
  })
  return { resets: () => resets }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('local base refresh against a held index.lock with real Git', () => {
  it('retries once the other git process releases the lock', async () => {
    const { repoPath, lockPath, remoteOid } = await createBehindRepoWithIndexLock()
    const spy = spyOnFailedResets(() => rm(lockPath, { force: true }))

    const result = await refreshLocalBaseRefForWorktreeCreate(
      repoPath,
      'origin/main',
      'refs/remotes/origin/main'
    )

    expect(result).toMatchObject({ status: 'updated' })
    expect(spy.resets()).toBe(2)
    expect(git(repoPath, ['rev-parse', 'main'])).toBe(remoteOid)
    expect(await readFile(join(repoPath, 'version.txt'), 'utf8')).toBe('two\n')
  })

  it('reports updated when another process fast-forwarded local while holding the lock', async () => {
    const { repoPath, remoteOid } = await createBehindRepoWithIndexLock()
    const spy = spyOnFailedResets(() => {
      git(repoPath, ['update-ref', 'refs/heads/main', remoteOid])
    })

    const result = await refreshLocalBaseRefForWorktreeCreate(
      repoPath,
      'origin/main',
      'refs/remotes/origin/main'
    )

    expect(result).toMatchObject({ status: 'updated' })
    expect(spy.resets()).toBe(1)
  })

  it('reports skipped_error when the lock outlives every retry', async () => {
    const { repoPath, remoteOid } = await createBehindRepoWithIndexLock()
    const spy = spyOnFailedResets(() => {})

    const result = await refreshLocalBaseRefForWorktreeCreate(
      repoPath,
      'origin/main',
      'refs/remotes/origin/main'
    )

    expect(result).toMatchObject({ status: 'skipped_error' })
    expect(spy.resets()).toBe(4)
    expect(git(repoPath, ['rev-parse', 'main'])).not.toBe(remoteOid)
  })
})
