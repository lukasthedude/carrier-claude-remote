// The seam between the engine and "how a task actually runs". SdkRunner drives
// Claude Code; FakeRunner (runner-fake.ts) is a deterministic stub the tests use
// so CI never needs a Claude login. Everything the engine needs from a run is
// expressed here so the two implementations are interchangeable.

import type { Task } from './state'

export interface AskQuestion {
  q: string
  header?: string
  multi?: boolean
  options: { label: string; desc?: string }[]
}

export interface RunContext {
  cwd: string
  model: string
  permissionMode: string
  progress: 'all' | 'final'
  resumeSessionId?: string
  /** the Claude session id, once known — persisted for conversational resume */
  onSessionId(id: string): void
  /** an intermediate note from Claude, forwarded to the chat when progress='all' */
  onProgress(text: string): void
  /** ask the owner and resolve with their answer text; rejects if cancelled */
  onAsk(questions: AskQuestion[]): Promise<string>
  /** ask-on-risky verdict for a tool call */
  classify(toolName: string, input: Record<string, unknown>): 'auto' | 'ask'
}

export interface RunResult {
  ok: boolean
  result: string
  costUsd?: number
  durationMs: number
}

export interface RunHandle {
  interrupt(): void
}

export interface ClaudeRunner {
  run(task: Task, ctx: RunContext): { handle: RunHandle; done: Promise<RunResult> }
}
