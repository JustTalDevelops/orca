import { afterEach, describe, expect, it, vi } from 'vitest'
import { createKeyedSerialRunner } from './keyed-serial-runner'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('createKeyedSerialRunner', () => {
  afterEach(() => vi.useRealTimers())

  it('runs same-key work in order and different keys concurrently', async () => {
    const run = createKeyedSerialRunner()
    const gate = deferred()
    const order: string[] = []
    const first = run('a', async () => {
      await gate.promise
      order.push('a1')
    })
    const second = run('a', async () => {
      order.push('a2')
    })
    await run('b', async () => {
      order.push('b')
    })
    gate.resolve()
    await Promise.all([first, second])
    expect(order).toEqual(['b', 'a1', 'a2'])
  })

  it('keeps the queue moving after a failed run', async () => {
    const run = createKeyedSerialRunner()
    const failed = run('a', () => Promise.reject(new Error('boom')))
    await expect(failed).rejects.toThrow('boom')
    await expect(run('a', async () => 'next')).resolves.toBe('next')
  })

  it('stops waiting for a predecessor that never settles once maxWaitMs passes', async () => {
    vi.useFakeTimers()
    const run = createKeyedSerialRunner({ maxWaitMs: 1_000 })
    void run('a', () => new Promise<void>(() => {}))
    const next = vi.fn(async () => 'ran')
    const pending = run('a', next)

    await vi.advanceTimersByTimeAsync(999)
    expect(next).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toBe('ran')
  })
})
