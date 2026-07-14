// The real runner: drives Claude Code via the Claude Agent SDK. The SDK is a
// peer dependency the bridge user installs on their Mac (npm i
// @anthropic-ai/claude-agent-sdk); it's imported lazily via a computed specifier
// so this file typechecks and CI runs (on the fake runner) without it.
//
// NOTE: the SDK message/option shapes below follow the current docs but can only
// be exercised on a machine with a Claude login — verify end-to-end on the Mac.
// The engine only depends on the ClaudeRunner interface, so any SDK drift is
// contained to this file.

import type { AskQuestion, ClaudeRunner, RunContext, RunHandle, RunResult } from './runner'
import type { Task } from './state'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

// Computed so TS can't statically resolve (and demand) the optional package.
const SDK_SPECIFIER = ['@anthropic-ai', 'claude-agent-sdk'].join('/')

const SYSTEM_APPEND = [
  'You are running headless, driven from a phone chat over Carrier.',
  'Keep narration short — the owner reads your text as chat messages, not a terminal.',
  'Lead your final summary with the outcome: what changed, or the answer.',
  'When you genuinely need the owner to decide, use AskUserQuestion with clear options.',
].join(' ')

export class SdkRunner implements ClaudeRunner {
  run(task: Task, ctx: RunContext): { handle: RunHandle; done: Promise<RunResult> } {
    let query: Any = null
    // Steerable input: the stream stays open, and steer() pushes another owner
    // message into the live conversation (processed as the next turn).
    const pending: Any[] = [{ type: 'user', message: { role: 'user', content: task.text } }]
    let pushed = 1
    let wake: (() => void) | null = null
    const push = (m: Any) => {
      pending.push(m)
      pushed++
      wake?.()
      wake = null
    }
    const handle: RunHandle = {
      interrupt: () => {
        try {
          query?.interrupt?.()
        } catch {
          /* already gone */
        }
      },
      steer: (text: string) => push({ type: 'user', message: { role: 'user', content: text } }),
      setMode: (mode: string) => {
        try {
          query?.setPermissionMode?.(mode)
        } catch {
          /* not live yet / already done — the next task picks it up anyway */
        }
      },
    }
    const done = this.exec(task, ctx, pending, () => pushed, (r) => (wake = r), (q) => { query = q }).catch(
      (e): RunResult => ({ ok: false, result: `Runner error: ${(e as Error).message}`, durationMs: 0 }),
    )
    return { handle, done }
  }

  private async exec(
    task: Task,
    ctx: RunContext,
    pending: Any[],
    pushedCount: () => number,
    onIdle: (wake: () => void) => void,
    setQuery: (q: Any) => void,
  ): Promise<RunResult> {
    const t0 = Date.now()
    let sdk: Any
    try {
      sdk = await import(/* @vite-ignore */ SDK_SPECIFIER)
    } catch {
      return { ok: false, result: `Claude Agent SDK not installed. On the Mac run:  npm i ${SDK_SPECIFIER}`, durationMs: Date.now() - t0 }
    }

    // Streaming-input mode (a generator that stays open) is required for
    // interrupt(), permission round-trips, and mid-run steering.
    async function* prompt(): AsyncGenerator<Any> {
      for (;;) {
        while (pending.length) yield pending.shift()
        await new Promise<void>((r) => onIdle(r))
      }
    }

    const options: Any = {
      cwd: ctx.cwd,
      model: ctx.model,
      permissionMode: ctx.permissionMode,
      ...(ctx.effort ? { effort: ctx.effort } : {}),
      ...(ctx.resumeSessionId ? { resume: ctx.resumeSessionId } : {}),
      systemPrompt: { type: 'preset', preset: 'claude_code', append: SYSTEM_APPEND },
      canUseTool: async (toolName: string, input: Record<string, unknown>) => {
        if (toolName === 'AskUserQuestion') {
          const rawQs = (input['questions'] as Any[]) ?? []
          const qs: AskQuestion[] = rawQs.map((q: Any) => ({
            q: String(q.question ?? 'Which?'),
            ...(q.header ? { header: String(q.header) } : {}),
            ...(q.multiSelect ? { multi: true } : {}),
            options: ((q.options as Any[]) ?? []).map((o: Any) => ({ label: String(o.label), ...(o.description ? { desc: String(o.description) } : {}) })),
          }))
          const answer = await ctx.onAsk(qs)
          const first = rawQs[0]
          const answers = first ? { [String(first.question)]: answer } : {}
          return { behavior: 'allow', updatedInput: { ...input, answers } }
        }
        if (ctx.classify(toolName, input) === 'auto') return { behavior: 'allow', updatedInput: input }
        const answer = await ctx.onAsk([{ q: describeTool(toolName, input), options: [{ label: 'Allow' }, { label: 'Deny' }] }])
        const yes = /^(allow|yes|y|ok|okay|approve|1)$/i.test(answer.trim())
        return yes
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: answer.trim() || 'Denied from phone' }
      },
    }

    const query = sdk.query({ prompt: prompt(), options })
    setQuery(query)
    let result = ''
    let costUsd: number | undefined
    let ok = true
    let results = 0
    try {
      for await (const msg of query as AsyncIterable<Any>) {
        if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) ctx.onSessionId(String(msg.session_id))
        else if (msg.type === 'assistant' && ctx.progress === 'all') {
          const text = extractText(msg)
          if (text) ctx.onProgress(text)
        } else if (msg.type === 'result') {
          // One result per user turn — a steer pushes another turn, so only
          // finish once every pushed message has its result (the last one wins).
          results++
          result = typeof msg.result === 'string' ? msg.result : ''
          if (typeof msg.total_cost_usd === 'number') costUsd = (costUsd ?? 0) + msg.total_cost_usd
          ok = !msg.is_error
          if (results >= pushedCount()) break
        }
      }
    } finally {
      try {
        query.return?.()
      } catch {
        /* generator already closed */
      }
    }
    return { ok, result: result || (ok ? 'Done.' : 'Failed.'), ...(costUsd !== undefined ? { costUsd } : {}), durationMs: Date.now() - t0 }
  }
}

function extractText(msg: Any): string {
  const content = msg?.message?.content
  if (!Array.isArray(content)) return ''
  return content.filter((b: Any) => b?.type === 'text').map((b: Any) => String(b.text)).join('').trim()
}

function describeTool(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'Bash' && typeof input['command'] === 'string') return `Run \`${(input['command'] as string).slice(0, 300)}\` ?`
  const fp = input['file_path'] ?? input['path']
  if (typeof fp === 'string') return `Allow ${toolName} on ${fp} ?`
  return `Allow ${toolName} ?`
}
