export type KeyedSerialRunner = <T>(key: string, fn: () => Promise<T>) => Promise<T>

/**
 * Runs `fn` after every earlier run with the same key has settled; different keys run concurrently.
 * With `maxWaitMs`, a run stops waiting for a predecessor that has not settled by then and starts anyway.
 */
export function createKeyedSerialRunner(options: { maxWaitMs?: number } = {}): KeyedSerialRunner {
  const tails = new Map<string, Promise<unknown>>()
  return <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prior = tails.get(key) ?? Promise.resolve()
    const run = boundedWait(prior, options.maxWaitMs).then(fn)
    // Why: keep the queue alive past a failed run so later entrants still start.
    const tail = run.then(
      () => undefined,
      () => undefined
    )
    tails.set(key, tail)
    void tail.then(() => {
      if (tails.get(key) === tail) {
        tails.delete(key)
      }
    })
    return run
  }
}

function boundedWait(prior: Promise<unknown>, maxWaitMs: number | undefined): Promise<unknown> {
  if (maxWaitMs === undefined) {
    return prior
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    prior,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, maxWaitMs)
    })
  ]).finally(() => clearTimeout(timer))
}
