import {
  resolveAgentWorktreeDisplayStatus,
  resolveWireAgentPaneDisplayState,
  type AgentStatusDisplayState
} from '../shared/agent-status-display-state'
import { isFreshNonDoneAgentStatus } from '../shared/agent-status-freshness'
import type {
  RuntimeWorktreeAgentRow,
  RuntimeWorktreePsResult,
  RuntimeWorktreePsSummary
} from '../shared/runtime-types'

export type DisplayedWorktreeAgentRow = RuntimeWorktreeAgentRow & {
  displayState?: AgentStatusDisplayState
}

export type DisplayedWorktreePsSummary = Omit<RuntimeWorktreePsSummary, 'agents'> & {
  displayStatus: RuntimeWorktreePsSummary['status'] | 'failed'
  agents: DisplayedWorktreeAgentRow[]
}

export type WithWorktreePsDisplayStatus<
  TResult extends Pick<RuntimeWorktreePsResult, 'worktrees'>
> = Omit<TResult, 'worktrees'> & { worktrees: DisplayedWorktreePsSummary[] }

/** CLI-computed presentation beside the host's lifecycle `status`, which stays as sent. */
export function withWorktreePsDisplayStatus<
  TResult extends Pick<RuntimeWorktreePsResult, 'worktrees'>
>(result: TResult, now = Date.now()): WithWorktreePsDisplayStatus<TResult> {
  return {
    ...result,
    worktrees: result.worktrees.map((worktree) => {
      let hasHumanWait = false
      let hasFailed = false
      const agents = worktree.agents.map((row): DisplayedWorktreeAgentRow => {
        // Why: decay live rows exactly where the host rollup stops counting them.
        const decayedTo =
          row.state !== 'done' && !isFreshNonDoneAgentStatus(row, now) ? 'idle' : undefined
        const displayState = resolveWireAgentPaneDisplayState(row, decayedTo)
        hasHumanWait ||= displayState === 'waiting' || displayState === 'blocked'
        hasFailed ||= displayState === 'failed'
        return displayState ? { ...row, displayState } : row
      })
      return {
        ...worktree,
        agents,
        displayStatus: resolveAgentWorktreeDisplayStatus({
          base: worktree.status,
          hasHumanWait,
          hasFailed
        })
      }
    })
  }
}
