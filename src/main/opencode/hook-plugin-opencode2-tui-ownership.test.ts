import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const { getPathMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

import { _internals } from './hook-service'

type Post = { paneKey?: string; payload?: { hook_event_name?: string; sessionID?: string } }
type BusEvent = { type: string; data: Record<string, unknown> }
type PluginModule = {
  default?: { setup?: (ctx: unknown) => Promise<(() => Promise<void>) | undefined> }
}

const PANE_A = 'tabA:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PANE_B = 'tabB:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SES_A = 'ses_f161fd85fffeieT0zYt80ZKorS'
const SES_B = 'ses_f161fcd7affeffV0OOrMCrTxtQ'
const ENV_KEYS = [
  'ORCA_PANE_KEY',
  'ORCA_OPENCODE_AGENT',
  'ORCA_AGENT_HOOK_ENDPOINT',
  'ORCA_AGENT_HOOK_PORT',
  'ORCA_AGENT_HOOK_TOKEN'
] as const

// Event shapes as OpenCode 2.0.14 delivers them to both server and TUI plugins.
function turn(sessionID: string, text: string): { start: BusEvent[]; finish: BusEvent[] } {
  const assistantMessageID = `msg_${sessionID}_a`
  return {
    start: [
      {
        type: 'session.created',
        data: { sessionID, projectID: 'global', location: { directory: '/proj' }, subpath: '' }
      },
      {
        type: 'session.inbox.enqueued',
        data: {
          sessionID,
          inboxID: `msg_${sessionID}_u`,
          item: { type: 'user', payload: { text, files: [] }, delivery: 'steer' }
        }
      },
      { type: 'session.execution.started', data: { sessionID } },
      { type: 'session.step.started', data: { sessionID, assistantMessageID, agent: 'build' } },
      { type: 'session.text.started', data: { sessionID, assistantMessageID, ordinal: 0 } }
    ],
    finish: [
      {
        type: 'session.text.ended',
        data: { sessionID, assistantMessageID, ordinal: 0, text: 'tick0 tick1 ' }
      },
      { type: 'session.step.ended', data: { sessionID, assistantMessageID, finish: 'stop' } },
      { type: 'session.execution.succeeded', data: { sessionID } }
    ]
  }
}

/** One pane's TUI: its route, its view of the shared session store, and the shared event bus. */
function fakeTui(version = '2.0.14') {
  const listeners = new Set<(event: { details: BusEvent }) => void>()
  const sessions = new Map<string, { id: string; parentID?: string }>()
  const running = new Set<string>()
  let route: { type: string; sessionID?: string } = { type: 'home' }
  const listen = vi.fn((handler: (event: { details: BusEvent }) => void) => {
    listeners.add(handler)
    return () => listeners.delete(handler)
  })
  const ctx = {
    app: { version, channel: 'latest' },
    ui: { router: { current: () => route } },
    client: {
      session: { get: async ({ sessionID }: { sessionID: string }) => sessions.get(sessionID) }
    },
    data: {
      listen,
      session: {
        get: (id: string) => sessions.get(id),
        root: (id: string) => {
          let current = sessions.get(id)
          while (current?.parentID && sessions.has(current.parentID)) {
            current = sessions.get(current.parentID)
          }
          return current?.id ?? id
        },
        family: () => [],
        status: (id: string) => (running.has(id) ? 'running' : 'idle'),
        permission: { list: () => [] },
        form: { list: () => [] }
      }
    }
  }
  return {
    ctx,
    listen,
    navigate(sessionID: string) {
      route = { type: 'session', sessionID }
    },
    emit(event: BusEvent) {
      const sessionID = String(event.data.sessionID)
      if (event.type === 'session.created') {
        sessions.set(sessionID, { id: sessionID })
      } else if (event.type === 'session.execution.started') {
        running.add(sessionID)
      } else if (event.type === 'session.execution.succeeded') {
        running.delete(sessionID)
      }
      for (const handler of listeners) {
        handler({ details: event })
      }
    }
  }
}

describe('OpenCode 2 TUI adapter: each pane reports its own sessions', () => {
  let tempDir: string
  let savedFetch: typeof globalThis.fetch
  let savedEnv: Record<string, string | undefined>
  let savedArgv: string[]
  let posts: Post[]

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-opencode-tui-adapter-'))
    savedFetch = globalThis.fetch
    savedArgv = process.argv
    savedEnv = {}
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key]
    }
    process.env.ORCA_OPENCODE_AGENT = 'opencode'
    delete process.env.ORCA_AGENT_HOOK_ENDPOINT
    process.env.ORCA_AGENT_HOOK_PORT = '59999'
    process.env.ORCA_AGENT_HOOK_TOKEN = 'test-token'
    posts = []
    globalThis.fetch = vi.fn(async (_input, init) => {
      posts.push(JSON.parse(String(init?.body)))
      return new Response('{}', { status: 200 })
    })
  })

  afterEach(() => {
    globalThis.fetch = savedFetch
    process.argv = savedArgv
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = savedEnv[key]
      }
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  async function loadPlugin(dir = tempDir): Promise<PluginModule> {
    // Why: a unique basename per load defeats the ESM module cache, like a separate process.
    const pluginPath = join(dir, `orca-opencode-status-${Math.random().toString(36).slice(2)}.mjs`)
    writeFileSync(pluginPath, _internals.getOpenCodePluginSource())
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the generated module's default export is exercised below and fails the test if absent.
    return (await import(pathToFileURL(pluginPath).href)) as PluginModule
  }

  const summary = (list: Post[]): string[] =>
    list.map((post) => `${post.payload?.hook_event_name}:${post.payload?.sessionID}`)

  async function runPane(
    paneKey: string,
    ownSession: string,
    script: (tui: ReturnType<typeof fakeTui>) => Promise<void>
  ): Promise<Post[]> {
    process.env.ORCA_PANE_KEY = paneKey
    const start = posts.length
    const tui = fakeTui()
    const cleanup = await (await loadPlugin()).default?.setup?.(tui.ctx)
    await script(tui)
    await vi.waitFor(() => {
      expect(summary(posts.slice(start)).at(-1)).toBe(`SessionIdle:${ownSession}`)
    })
    await cleanup?.()
    return posts.slice(start)
  }

  const tick = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
  const pump = async (tui: ReturnType<typeof fakeTui>, events: BusEvent[]): Promise<void> => {
    for (const event of events) {
      tui.emit(event)
      await tick()
    }
  }

  // Captured s2 shape: pane A's long turn overlapped by pane B's short one on one server.
  it('gives each overlapping pane only its own session and its own Idle', async () => {
    const a = turn(SES_A, 'A long SLEEP=12')
    const b = turn(SES_B, 'B short SLEEP=3')
    const bus = [...a.start, ...b.start, ...b.finish, ...a.finish]
    const paneA = await runPane(PANE_A, SES_A, async (tui) => {
      tui.navigate(SES_A)
      await pump(tui, bus)
    })
    const paneB = await runPane(PANE_B, SES_B, async (tui) => {
      await pump(tui, [...a.start])
      tui.navigate(SES_B)
      await pump(tui, [...b.start, ...b.finish, ...a.finish])
    })

    expect(paneA.every((post) => post.paneKey === PANE_A)).toBe(true)
    expect(paneB.every((post) => post.paneKey === PANE_B)).toBe(true)
    expect(new Set(paneA.map((post) => post.payload?.sessionID))).toEqual(new Set([SES_A]))
    expect(new Set(paneB.map((post) => post.payload?.sessionID))).toEqual(new Set([SES_B]))
    for (const [list, session] of [
      [paneA, SES_A],
      [paneB, SES_B]
    ] as const) {
      const names = summary(list)
      expect(names[0]).toBe(`SessionStart:${session}`)
      expect(names).toContain(`SessionBusy:${session}`)
      expect(names.at(-1)).toBe(`SessionIdle:${session}`)
    }
  })

  // Captured s5 shape: the TUI's route reached the new session after execution had started.
  it('hydrates a session whose route switch lands after execution started', async () => {
    const b = turn(SES_B, 'B tui SLEEP=4')
    const paneB = await runPane(PANE_B, SES_B, async (tui) => {
      await pump(tui, b.start)
      expect(posts).toHaveLength(0)
      tui.navigate(SES_B)
      await vi.waitFor(() => {
        expect(summary(posts)).toContain(`SessionBusy:${SES_B}`)
      })
      await pump(tui, b.finish)
    })

    const names = summary(paneB)
    expect(names.slice(0, 3)).toEqual([
      `SessionStart:${SES_B}`,
      `MessagePart:${SES_B}`,
      `SessionBusy:${SES_B}`
    ])
    expect(names.at(-1)).toBe(`SessionIdle:${SES_B}`)
  })

  it('keeps a started turn until it settles after the route moves on', async () => {
    const a = turn(SES_A, 'A long')
    const paneA = await runPane(PANE_A, SES_A, async (tui) => {
      tui.navigate(SES_A)
      await pump(tui, a.start)
      tui.navigate('ses_other_idle_session')
      await tick(250)
      await pump(tui, a.finish)
    })
    expect(summary(paneA)).toContain(`SessionBusy:${SES_A}`)
    expect(summary(paneA).at(-1)).toBe(`SessionIdle:${SES_A}`)
  })

  it('reports nothing for sessions the pane never showed', async () => {
    process.env.ORCA_PANE_KEY = PANE_A
    const tui = fakeTui()
    const cleanup = await (await loadPlugin()).default?.setup?.(tui.ctx)
    const b = turn(SES_B, 'another pane')
    await pump(tui, [...b.start, ...b.finish])
    await tick(250)
    await cleanup?.()
    expect(posts).toEqual([])
  })

  it.each([
    ['an OpenCode 1 TUI', () => fakeTui('1.18.33')],
    ['the other pane variant', () => fakeTui()]
  ])('stays silent in %s', async (label, make) => {
    if (label === 'the other pane variant') {
      process.env.ORCA_OPENCODE_AGENT = 'opencode2'
    }
    process.env.ORCA_PANE_KEY = PANE_A
    const tui = make()
    const cleanup = await (await loadPlugin()).default?.setup?.(tui.ctx)
    expect(tui.listen).not.toHaveBeenCalled()
    await cleanup?.()
  })

  describe('server plugin stand-down', () => {
    function serverContext() {
      const subscribe = vi.fn(async function* () {})
      const hook = vi.fn(async () => ({ dispose: vi.fn() }))
      return {
        subscribe,
        hook,
        ctx: {
          session: { hook, get: async () => undefined },
          event: { subscribe }
        }
      }
    }
    const installTuiCopy = (): void => {
      mkdirSync(join(tempDir, 'orca-opencode-status-tui'))
      writeFileSync(join(tempDir, 'orca-opencode-status-tui', 'tui.js'), '')
    }

    it('reports nothing from a serve process when the TUI copy is installed beside it', async () => {
      installTuiCopy()
      process.argv = [...savedArgv, 'serve', '--service']
      const server = serverContext()
      const cleanup = await (await loadPlugin()).default?.setup?.(server.ctx)
      expect(server.subscribe).not.toHaveBeenCalled()
      expect(server.hook).not.toHaveBeenCalled()
      await cleanup?.()
    })

    it('stands down in a --standalone private server too', async () => {
      installTuiCopy()
      process.argv = [...savedArgv, 'serve', '--stdio', '--port', '0']
      const server = serverContext()
      const cleanup = await (await loadPlugin()).default?.setup?.(server.ctx)
      expect(server.subscribe).not.toHaveBeenCalled()
      await cleanup?.()
    })

    // Why: an older SSH relay installs this file but not the TUI copy; nothing else would report.
    it('keeps reporting from a serve process whose installer wrote no TUI copy', async () => {
      process.argv = [...savedArgv, 'serve', '--service']
      const server = serverContext()
      const cleanup = await (await loadPlugin()).default?.setup?.(server.ctx)
      expect(server.subscribe).toHaveBeenCalled()
      await cleanup?.()
    })
  })
})
