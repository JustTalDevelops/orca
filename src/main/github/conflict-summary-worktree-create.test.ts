import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const gitExecFileAsyncMock = vi.hoisted(() => vi.fn())

vi.mock('../git/runner', () => ({ gitExecFileAsync: gitExecFileAsyncMock }))

import { __resetPRConflictSummaryCachesForTests, getPRConflictSummary } from './conflict-summary'
import {
  _resetWorktreeCreateRepoActivityForTests,
  holdRepoForWorktreeCreate
} from '../git/worktree-create-repo-activity'
import type { GitAdmissionTier } from '../git/command-runner/git-exec-options'

const outputs: Record<string, string> = {
  fetch: '',
  'rev-parse': 'base-tip\n',
  'merge-base': 'merge-base\n',
  'rev-list': '2\n',
  'merge-tree': 'tree-oid\u0000src/conflict.ts\u0000'
}

function summarize(repoPath: string, admissionTier: GitAdmissionTier) {
  return getPRConflictSummary(repoPath, 'main', 'github-base-oid', 'head-oid', { admissionTier })
}

beforeEach(() => {
  gitExecFileAsyncMock.mockReset()
  gitExecFileAsyncMock.mockImplementation(async (argv: string[]) => ({
    stdout: outputs[argv[0]] ?? ''
  }))
  __resetPRConflictSummaryCachesForTests()
})

afterEach(() => {
  _resetWorktreeCreateRepoActivityForTests()
})

describe('conflict summary while a worktree create is in flight', () => {
  it('starts no git for a background refresh until the create on its repo settles', async () => {
    const release = holdRepoForWorktreeCreate({ path: '/repo-root' })
    let settled = false
    const summary = summarize('/repo-root', 'background').then((value) => {
      settled = true
      return value
    })

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    expect(settled).toBe(false)

    release()
    await expect(summary).resolves.toMatchObject({ files: ['src/conflict.ts'] })
    const commands = gitExecFileAsyncMock.mock.calls.map(([argv]) => argv[0])
    expect(commands).toEqual(expect.arrayContaining(['fetch', 'merge-base', 'merge-tree']))
  })

  it('runs a user-initiated refresh immediately', async () => {
    const release = holdRepoForWorktreeCreate({ path: '/repo-root' })
    await expect(summarize('/repo-root', 'interactive')).resolves.toMatchObject({
      files: ['src/conflict.ts']
    })
    release()
  })

  it('does not wait on a create in a different repo', async () => {
    const release = holdRepoForWorktreeCreate({ path: '/other-repo' })
    await expect(summarize('/repo-root', 'background')).resolves.toMatchObject({
      files: ['src/conflict.ts']
    })
    release()
  })
})
