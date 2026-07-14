// The orchestration core: a FIFO task queue, the task state machine, the
// ask-back round-trip, model/cancel control, and live status emission. Wires the
// Carrier peer (chat I/O) to a ClaudeRunner (execution). Runner-agnostic.

import { randomBytes, toB64u } from '../src/crypto'
import { shortModel } from '../src/agentfmt'
import { projectCwd, type BridgeConfig } from './config'
import { HELP_TEXT, parseCommand } from './commands'
import { classifyTool } from './policy'
import type { AgentQuestion, CarrierPeer, PeerHandlers } from './peer'
import type { ClaudeRunner, RunContext, RunHandle } from './runner'
import { taskTitle, type EngineState, type Task } from './state'

const TYPING_PULSE_MS = 4000
// a-ctl is mailboxed (survives a brief drop), so a cancel older than this is
// treated as stale and ignored — it must not kill a task queued after it.
const CTL_STALE_MS = 90_000

interface PendingAsk {
  taskId: string
  resolve: (answer: string) => void
  reject: (err: Error) => void
}

interface Running {
  task: Task
  handle: RunHandle | null
}

export class Engine implements PeerHandlers {
  private currentModel: string
  private currentProject: string
  private currentMode: string
  private currentEffort: string | undefined
  private running: Running | null = null
  private pendingAsk: PendingAsk | null = null
  private typingTimer: ReturnType<typeof setInterval> | null = null
  private bootNote = ''

  constructor(
    private peer: CarrierPeer,
    private runner: ClaudeRunner,
    private config: BridgeConfig,
    private state: EngineState,
  ) {
    this.currentModel = config.model
    this.currentProject = config.defaultProject
    this.currentMode = state.mode ?? config.permissionMode
    this.currentEffort = state.effort
    this.recoverOnBoot()
  }

  /** Drop tasks that were mid-run when we crashed (never auto-rerun side
   *  effects); remaining 'queued' tasks will run once we're connected. */
  private recoverOnBoot(): void {
    const interrupted = this.state.queue.filter((t) => t.state === 'running' || t.state === 'waiting')
    if (interrupted.length) {
      this.state.queue = this.state.queue.filter((t) => t.state !== 'running' && t.state !== 'waiting')
      this.bootNote = `⚠️ I restarted while working on ${interrupted.length} task${interrupted.length > 1 ? 's' : ''}. Send ${interrupted.length > 1 ? 'them' : 'it'} again if still needed.`
      this.state.saveQueue()
    }
  }

  start(): void {
    this.kick()
  }

  // ---- PeerHandlers ----

  onOwnerConnected(): void {
    if (this.bootNote) {
      this.peer.sendText(this.bootNote)
      this.bootNote = ''
    }
    this.emitStatus()
    this.kick()
  }

  onOwnerMessage(text: string, msgId: string): void {
    const cmd = parseCommand(text)
    // While waiting on a question, a non-command line IS the answer.
    if (this.pendingAsk && cmd.kind === 'task') {
      const p = this.pendingAsk
      this.pendingAsk = null
      p.resolve(text)
      return
    }
    switch (cmd.kind) {
      case 'task':
        this.enqueue(msgId, text)
        return
      case 'queue':
        this.enqueue(msgId, cmd.text)
        return
      case 'status':
        this.emitStatus()
        return
      case 'model':
        this.handleModel(cmd.model)
        return
      case 'cancel':
        this.cancel(cmd.target)
        return
      case 'new': {
        this.state.clearSession(this.currentProject)
        this.peer.sendText(`🧠 Fresh session${this.currentProject ? ` for “${this.currentProject}”` : ''} — I’ve forgotten the earlier context.`)
        return
      }
      case 'project':
        this.handleProject(cmd.name)
        return
      case 'help':
        this.peer.sendText(HELP_TEXT)
        return
      case 'unknown':
        this.peer.sendText(`Unknown command /${cmd.name}.\n\n${HELP_TEXT}`)
        return
    }
  }

  onCtl(ctl: { model?: string; cancel?: string; sync?: true; mode?: string; effort?: string; move?: { id: string; to: number }; steer?: string; ts: number }): void {
    if (ctl.model) this.handleModel(ctl.model, true) // last-writer-wins; safe to apply anytime
    if (ctl.mode) this.handleMode(ctl.mode)
    if (ctl.effort) this.handleEffort(ctl.effort)
    if (ctl.move) this.moveTask(ctl.move)
    // Stale-guard the destructive/one-shot verbs the same way as cancel: a
    // mailbox-delayed steer must not hijack a task queued long after it.
    if (ctl.steer && Date.now() - ctl.ts <= CTL_STALE_MS) this.steer(ctl.steer)
    if (ctl.cancel && Date.now() - ctl.ts <= CTL_STALE_MS) this.cancel(ctl.cancel)
    if (ctl.sync) this.emitStatus()
  }

  // ---- queue / lifecycle ----

  private enqueue(id: string, text: string): void {
    const body = text.trim()
    if (!body) return
    if (this.state.queue.some((t) => t.id === id)) return // mailbox redelivery — no-op
    const active = this.state.queue.filter((t) => t.state === 'queued' || t.state === 'running' || t.state === 'waiting')
    if (active.length >= this.config.maxQueue) {
      this.peer.sendText(`📥 Queue is full (${this.config.maxQueue}). I’ll take more once I catch up.`)
      return
    }
    const task: Task = {
      id,
      text: body,
      project: this.currentProject,
      model: this.currentModel,
      state: 'queued',
      createdTs: Date.now(),
      title: taskTitle(body),
    }
    this.state.queue.push(task)
    this.state.saveQueue() // persist BEFORE the relay is told we took custody
    this.emitStatus()
    this.kick()
  }

  private kick(): void {
    if (this.running) return
    const next = this.state.queue.find((t) => t.state === 'queued')
    if (!next) return
    void this.run(next)
  }

  private async run(task: Task): Promise<void> {
    task.state = 'running'
    this.running = { task, handle: null }
    this.state.saveQueue()
    this.emitStatus()
    this.startTyping()

    const cwd = projectCwd(this.config, task.project)
    const ctx: RunContext = {
      cwd,
      model: task.model,
      permissionMode: this.currentMode,
      ...(this.currentEffort ? { effort: this.currentEffort } : {}),
      progress: this.config.progress,
      ...(this.state.session(task.project) ? { resumeSessionId: this.state.session(task.project) } : {}),
      onSessionId: (id) => this.state.setSession(task.project, id),
      onProgress: (t) => { if (t.trim()) this.peer.sendText(t) },
      onAsk: (questions) => this.ask(task, questions),
      classify: (tool, input) => classifyTool(tool, input, cwd),
    }

    let ok = false
    let result = 'cancelled'
    try {
      const { handle, done } = this.runner.run(task, ctx)
      this.running.handle = handle
      const res = await done
      ok = res.ok
      result = res.result
    } catch (e) {
      ok = false
      result = (e as Error).message || 'failed'
    }

    this.stopTyping()
    // task.state may have been flipped to 'cancelled' by cancel() while we
    // awaited; read it widened so TS doesn't assume it's still 'running'.
    const wasCancelled = (task.state as string) === 'cancelled'
    this.removeTask(task.id)
    this.running = null
    this.pendingAsk = null

    if (wasCancelled) {
      // the cancel path already sent a "cancelled" note
    } else if (ok) {
      // Just the result — no model/duration/cost footer (that's plumbing, not
      // conversation; the model already shows in the pill).
      this.peer.sendText(`✅ ${result}`)
    } else {
      this.peer.sendText(`❌ ${result}`)
    }
    this.emitStatus()
    this.kick()
  }

  /** Ask the owner a question and resolve with their answer text (mapped from a
   *  number/label to the option label when possible). */
  private ask(task: Task, questions: AgentQuestion[]): Promise<string> {
    task.state = 'waiting'
    this.state.saveQueue()
    this.stopTyping()
    const askId = toB64u(randomBytes(6))
    const msgId = this.peer.sendText(renderQuestions(questions))
    this.peer.sendAsk(askId, msgId || askId, questions)
    this.emitStatus()
    return new Promise<string>((resolve, reject) => {
      this.pendingAsk = { taskId: task.id, resolve, reject }
    }).then((answer) => {
      task.state = 'running'
      this.startTyping()
      this.emitStatus()
      return mapAnswer(answer, questions)
    })
  }

  private cancel(target?: string): void {
    const all = !target || target === 'all'
    // Drop queued tasks (all, or the one addressed).
    const before = this.state.queue.length
    this.state.queue = this.state.queue.filter((t) => {
      if (t.state !== 'queued') return true
      return all ? false : t.id !== target
    })
    let touched = this.state.queue.length !== before
    // Interrupt the running task if it's the target (or 'all'/unspecified).
    if (this.running && (all || target === undefined || this.running.task.id === target)) {
      this.running.task.state = 'cancelled'
      this.running.handle?.interrupt()
      if (this.pendingAsk) {
        const p = this.pendingAsk
        this.pendingAsk = null
        p.reject(new Error('cancelled'))
      }
      touched = true
    }
    this.state.saveQueue()
    this.peer.sendText(touched ? '🛑 Cancelled.' : 'Nothing to cancel.')
    this.emitStatus()
  }

  private handleModel(model: string | undefined, fromCtl = false): void {
    if (!model) {
      this.peer.sendText(`Models: ${this.config.models.join(', ')}\nCurrent: ${shortModel(this.currentModel)}`)
      return
    }
    if (model.length > 48) {
      this.peer.sendText('That model name looks too long.')
      return
    }
    this.currentModel = model
    if (!fromCtl) this.peer.sendText(`🔀 Model → ${shortModel(model)} (applies to your next task).`)
    this.emitStatus()
  }

  /** Switch the permission mode ('default' ↔ 'plan') — applies to the running
   *  task live (SDK setPermissionMode) AND to everything after; persisted. */
  private handleMode(mode: string): void {
    if (mode !== 'default' && mode !== 'plan' && mode !== 'acceptEdits') return // loose but bounded
    if (mode === this.currentMode) return
    this.currentMode = mode
    this.state.setPrefs({ mode })
    this.running?.handle?.setMode?.(mode)
    this.emitStatus()
  }

  /** Set the reasoning effort — applies from the next task (a query option). */
  private handleEffort(effort: string): void {
    if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) return
    if (effort === this.currentEffort) return
    this.currentEffort = effort
    this.state.setPrefs({ effort })
    this.emitStatus()
  }

  /** Reorder a QUEUED task to index `to` among the queued (running/waiting
   *  tasks keep their place at the front). */
  private moveTask(move: { id: string; to: number }): void {
    const queued = this.state.queue.filter((t) => t.state === 'queued')
    const others = this.state.queue.filter((t) => t.state !== 'queued')
    const from = queued.findIndex((t) => t.id === move.id)
    if (from < 0) return
    const [task] = queued.splice(from, 1)
    queued.splice(Math.max(0, Math.min(move.to, queued.length)), 0, task!)
    this.state.queue = [...others, ...queued]
    this.state.saveQueue()
    this.emitStatus()
  }

  /** Promote a queued task into the LIVE run: its text is injected into the
   *  running conversation as the next turn (Conductor-style steering). With
   *  nothing running (or a runner that can't steer) it degrades to run-next. */
  private steer(id: string): void {
    const task = this.state.queue.find((t) => t.id === id && t.state === 'queued')
    if (!task) return
    if (this.running && this.running.handle?.steer && (this.running.task.state as string) !== 'cancelled') {
      this.state.queue = this.state.queue.filter((t) => t.id !== id)
      this.state.saveQueue()
      this.running.handle.steer(task.text)
      this.peer.sendText(`↪️ Steering the current task: “${task.title}”`)
      this.emitStatus()
      return
    }
    this.moveTask({ id, to: 0 }) // nothing live to steer — make it next instead
  }

  private handleProject(name: string | undefined): void {
    const names = Object.keys(this.config.projects)
    if (!name) {
      this.peer.sendText(`Projects: ${names.join(', ') || '(none — set them in config.json)'}\nCurrent: ${this.currentProject || '(cwd)'}`)
      return
    }
    if (!this.config.projects[name]) {
      this.peer.sendText(`No project “${name}”. I have: ${names.join(', ') || '(none)'}`)
      return
    }
    this.currentProject = name
    this.peer.sendText(`📂 Project → ${name} (applies to your next task).`)
  }

  private removeTask(id: string): void {
    this.state.queue = this.state.queue.filter((t) => t.id !== id)
    this.state.saveQueue()
  }

  private emitStatus(): void {
    const queue = this.state.queue
      .filter((t) => t.state === 'queued' || t.state === 'running' || t.state === 'waiting')
      .map((t) => ({ id: t.id, title: t.title, state: t.state }))
    const state = this.running ? (this.running.task.state === 'waiting' ? 'waiting' : 'busy') : 'idle'
    this.peer.sendStatus({ state, model: this.currentModel, models: this.config.models, queue, mode: this.currentMode, ...(this.currentEffort ? { effort: this.currentEffort } : {}) })
  }

  private startTyping(): void {
    this.stopTyping()
    this.peer.sendTyping(true)
    this.typingTimer = setInterval(() => this.peer.sendTyping(true), TYPING_PULSE_MS)
  }
  private stopTyping(): void {
    if (this.typingTimer) {
      clearInterval(this.typingTimer)
      this.typingTimer = null
      this.peer.sendTyping(false)
    }
  }
}

/** A number, an exact/prefix label match, or free text → the chosen option label
 *  (or the raw text if it matches nothing). */
export function mapAnswer(answer: string, questions: AgentQuestion[]): string {
  const a = answer.trim()
  const opts = questions[0]?.options ?? []
  const n = Number.parseInt(a, 10)
  if (!Number.isNaN(n) && n >= 1 && n <= opts.length) return opts[n - 1]!.label
  const lower = a.toLowerCase()
  const exact = opts.find((o) => o.label.toLowerCase() === lower)
  if (exact) return exact.label
  const prefix = opts.find((o) => o.label.toLowerCase().startsWith(lower))
  if (prefix && lower.length >= 2) return prefix.label
  return answer
}

function renderQuestions(questions: AgentQuestion[]): string {
  if (questions.length === 1) {
    const q = questions[0]!
    const lines = [q.q, '', ...q.options.map((o, i) => `${i + 1}. ${o.label}${o.desc ? ` — ${o.desc}` : ''}`)]
    lines.push('', 'Reply with a number, or just type your answer.')
    return lines.join('\n')
  }
  const blocks = questions.map((q, qi) => {
    const opts = q.options.map((o, i) => `  ${i + 1}. ${o.label}${o.desc ? ` — ${o.desc}` : ''}`)
    return [`${qi + 1}) ${q.q}`, ...opts].join('\n')
  })
  return ['I have a few questions:', '', ...blocks, '', 'Answer in order, or type freely.'].join('\n')
}

