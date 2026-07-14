// Deterministic runner for tests — no Claude login, no SDK. Behavior is keyed by
// a leading "verb:" in the task text so tests can drive every path:
//   echo: X        → result X
//   fail: X        → failed, result X
//   long: N        → an N-char result (exercises reply chunking)
//   progress: X    → emits one progress note, result X
//   ask: Q | A;B   → one question round-trip, result "answered: <answer>"
//   sleep: N       → wait N ms, interruptible (result "cancelled" if stopped)
//   <anything>     → result "done: <text>"

import type { ClaudeRunner, RunContext, RunHandle, RunResult } from './runner'
import type { Task } from './state'

export class FakeRunner implements ClaudeRunner {
  run(task: Task, ctx: RunContext): { handle: RunHandle; done: Promise<RunResult> } {
    let cancelled = false
    let steered: string | null = null
    const handle: RunHandle = {
      interrupt: () => { cancelled = true },
      // steering a fake sleep finishes it immediately with the injected text —
      // deterministic proof the live run consumed the steer
      steer: (text: string) => { steered = text },
      setMode: () => {},
    }
    const done = this.exec(task, ctx, () => cancelled, () => steered)
    return { handle, done }
  }

  private async exec(task: Task, ctx: RunContext, isCancelled: () => boolean, getSteer: () => string | null): Promise<RunResult> {
    const t0 = Date.now()
    const fin = (ok: boolean, result: string): RunResult => ({ ok, result, costUsd: 0, durationMs: Date.now() - t0 })
    ctx.onSessionId(`fake-session-${task.project || 'default'}`)

    const m = /^(\w+):\s*([\s\S]*)$/.exec(task.text.trim())
    const verb = m?.[1]?.toLowerCase()
    const rest = m?.[2] ?? ''

    if (verb === 'echo') return fin(true, rest)
    if (verb === 'fail') return fin(false, rest || 'boom')
    if (verb === 'long') return fin(true, 'x'.repeat(Number(rest) || 9000))
    if (verb === 'progress') {
      ctx.onProgress('Working on it…')
      return fin(true, rest || 'done')
    }
    if (verb === 'ask') {
      const [q, opts] = rest.split('|')
      const options = (opts ?? 'Yes;No').split(';').map((s) => ({ label: s.trim() })).filter((o) => o.label)
      const answer = await ctx.onAsk([{ q: (q ?? 'Which?').trim(), options }])
      return fin(true, `answered: ${answer}`)
    }
    if (verb === 'sleep') {
      const ms = Number(rest) || 1000
      const start = Date.now()
      while (Date.now() - start < ms) {
        if (isCancelled()) return fin(false, 'cancelled')
        const s = getSteer()
        if (s !== null) return fin(true, `steered: ${s}`)
        await new Promise((r) => setTimeout(r, 25))
      }
      return fin(true, `slept ${ms}`)
    }
    return fin(true, `done: ${task.text}`)
  }
}
