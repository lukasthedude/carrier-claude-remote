// The Carrier-protocol layer: one Carrier identity + relay socket. Decodes
// owner frames → handler callbacks, encodes replies. Generic enough to power
// BOTH a task agent (caps:['cc'], owner preset by the host) and the host control
// channel (caps:['cc','host'], pins its own owner, speaks a-host/a-spawn/…).

import { formatSafetyNumber, fromB64u, randomBytes, safetyNumber, toB64u, utf8Encode, type Identity } from '../src/crypto'
import { decodeFrame, encodeFrame, MAX_HIST_ENTRIES, type Inner } from '../src/protocol'
import { chunkText } from './chunk'
import { BridgeRelay } from './relay'
import type { AskQuestion } from './runner'

// One canonical question shape, shared with the runner (which produces it).
export type AgentQuestion = AskQuestion

export interface PeerOpts {
  identity: Identity
  name: string
  relay: string
  signupCode: string
  private: boolean
  /** hello caps: ['cc'] for an agent, ['cc','host'] for the host. */
  caps?: string[]
  /** preset for agents (the host's owner); null ⇒ this peer pins its own owner. */
  ownerPk?: string | null
  /** shown in the agent's a-status (which worktree it runs in). */
  project?: string
  branch?: string
  /** the host persists the owner it pins here. */
  onOwnerPin?: (pk: string) => void
  onSignupGate: (code: string, msg: string) => void
  /** agents run silent; only the host narrates to the console. */
  quiet?: boolean
}

export interface PeerHandlers {
  // agent role
  onOwnerMessage?(text: string, msgId: string): void
  onCtl?(ctl: { model?: string; cancel?: string; sync?: true; mode?: string; effort?: string; move?: { id: string; to: number }; steer?: string; ts: number }): void
  onOwnerConnected?(): void
  // host role
  onSpawn?(spawn: { project: string; branch?: string; attach?: string }): void
  onClose?(pk: string): void
  onList?(project: string): void
}

export class CarrierPeer {
  handlers: PeerHandlers | null = null
  readonly myPk: string
  private relay: BridgeRelay
  private identity: Identity
  private ownerPk: string | null

  constructor(private opts: PeerOpts) {
    this.identity = opts.identity
    this.myPk = toB64u(this.identity.publicKey)
    this.ownerPk = opts.ownerPk ?? null
    this.relay = new BridgeRelay(opts.relay, this.identity, opts.signupCode, opts.private, {
      onReady: () => this.onReady(),
      onFrame: (from, data) => this.onFrame(from, data),
      onSent: () => {},
      onSignupGate: (code, msg) => opts.onSignupGate(code, msg),
      onConnectionChange: (c) => { if (!opts.quiet) console.log(c ? '[relay] connected' : '[relay] disconnected — reconnecting…') },
    })
  }

  start(): void {
    this.relay.start()
  }
  stop(): void {
    this.relay.stop()
  }
  get owner(): string | null {
    return this.ownerPk
  }

  /** `${pk}.${b64u(name)}` — paste this into Carrier's "Add a friend". */
  chatCode(): string {
    return `${this.myPk}.${toB64u(utf8Encode(this.opts.name))}`
  }

  private hello(): Inner {
    return { kind: 'hello', name: this.opts.name, pk: this.myPk, caps: this.opts.caps ?? ['cc'] }
  }

  private onReady(): void {
    if (this.ownerPk) {
      this.sendInner(this.ownerPk, this.hello()) // remind the phone who we are + our caps
      this.handlers?.onOwnerConnected?.()
    }
  }

  private async onFrame(from: string, data: string): Promise<void> {
    let inner: Inner | null
    try {
      inner = decodeFrame(data, fromB64u(from), this.identity.privateKey)
    } catch {
      return // not for us / forged / noise
    }
    if (!inner) return

    if (!this.ownerPk) {
      // Unpaired (host only): the first genuine 1:1 hello becomes the owner.
      if (inner.kind === 'hello' && !inner.gid) {
        this.ownerPk = from
        this.opts.onOwnerPin?.(from)
        this.sendInner(from, this.hello())
        if (!this.opts.quiet) this.printSafety(from)
        this.handlers?.onOwnerConnected?.()
      }
      return
    }
    if (from !== this.ownerPk) return // pinned — ignore every other sender

    switch (inner.kind) {
      case 'hello':
        this.sendInner(from, this.hello())
        this.handlers?.onOwnerConnected?.()
        return
      case 'msg':
        this.sendAck([inner.id])
        this.handlers?.onOwnerMessage?.(inner.text, inner.id)
        return
      case 'a-ctl':
        this.handlers?.onCtl?.({
          ts: inner.ts,
          ...(inner.model ? { model: inner.model } : {}),
          ...(inner.cancel ? { cancel: inner.cancel } : {}),
          ...(inner.sync ? { sync: true } : {}),
          ...(inner.mode ? { mode: inner.mode } : {}),
          ...(inner.effort ? { effort: inner.effort } : {}),
          ...(inner.move ? { move: inner.move } : {}),
          ...(inner.steer ? { steer: inner.steer } : {}),
        })
        return
      case 'a-spawn':
        this.handlers?.onSpawn?.({ project: inner.project, ...(inner.branch ? { branch: inner.branch } : {}), ...(inner.attach ? { attach: inner.attach } : {}) })
        return
      case 'a-close':
        this.handlers?.onClose?.(inner.pk)
        return
      case 'a-list':
        this.handlers?.onList?.(inner.project)
        return
      default:
        return
    }
  }

  // ---- send verbs (owner resolved internally) ----

  /** Send text to the owner, chunked to fit MAX_TEXT. Returns the first msg id. */
  sendText(text: string): string {
    if (!this.ownerPk || !text.trim()) return ''
    let firstId = ''
    let ts = Date.now()
    for (const chunk of chunkText(text)) {
      if (!chunk) continue
      const id = toB64u(randomBytes(8))
      if (!firstId) firstId = id
      this.sendInner(this.ownerPk, { kind: 'msg', id, ts, text: chunk })
      ts += 1
    }
    return firstId
  }

  sendStatus(status: { state: string; model: string; models: string[]; queue: { id: string; title: string; state: string }[]; mode?: string; effort?: string }): void {
    if (!this.ownerPk) return
    this.sendInner(this.ownerPk, {
      kind: 'a-status',
      ts: Date.now(),
      ...status,
      ...(this.opts.project ? { project: this.opts.project } : {}),
      ...(this.opts.branch ? { branch: this.opts.branch } : {}),
    })
  }

  sendAsk(ask: string, msgId: string, questions: AgentQuestion[]): void {
    if (!this.ownerPk) return
    const clamped: AgentQuestion[] = questions.slice(0, 4).map((q) => ({
      q: q.q.slice(0, 500),
      ...(q.header ? { header: q.header.slice(0, 16) } : {}),
      ...(q.multi ? { multi: true as const } : {}),
      options: q.options.slice(0, 8).map((o) => ({ label: o.label.slice(0, 120), ...(o.desc ? { desc: o.desc.slice(0, 250) } : {}) })),
    }))
    if (clamped.some((q) => q.options.length < 2)) return
    this.sendInner(this.ownerPk, { kind: 'a-ask', ask, msgId, questions: clamped })
  }

  sendTyping(on: boolean): void {
    if (!this.ownerPk) return
    this.sendInner(this.ownerPk, { kind: 'typing', on })
  }

  sendAck(ids: string[]): void {
    if (!this.ownerPk) return
    this.sendInner(this.ownerPk, { kind: 'ack', ids })
  }

  // ---- host-only send verbs ----

  sendHostRoster(agents: { pk: string; name: string; state: string; project?: string; branch?: string }[], projects: { name: string }[]): void {
    if (!this.ownerPk) return
    this.sendInner(this.ownerPk, { kind: 'a-host', ts: Date.now(), agents, projects })
  }

  sendSessions(project: string, sessions: { id: string; title: string; branch?: string; updatedAt: number }[]): void {
    if (!this.ownerPk) return
    this.sendInner(this.ownerPk, { kind: 'a-sessions', project, sessions })
  }

  /** Backfill an attached session's recent transcript to the phone, chunked.
   *  Mailboxed (store:true) but never pushed — history shouldn't buzz anyone. */
  sendHist(sid: string, entries: { role: string; text: string; ts: number }[]): void {
    if (!this.ownerPk || entries.length === 0) return
    for (let off = 0; off < entries.length; off += MAX_HIST_ENTRIES)
      this.sendInner(this.ownerPk, { kind: 'a-hist', sid, off, total: entries.length, entries: entries.slice(off, off + MAX_HIST_ENTRIES) })
  }

  private sendInner(to: string, inner: Inner): void {
    let frame: string
    try {
      frame = encodeFrame(inner, fromB64u(to), this.identity.privateKey)
    } catch {
      return
    }
    const push = inner.kind === 'msg'
    // volatile presence (a-status/a-host) isn't mailboxed; everything else is.
    const store = inner.kind !== 'typing' && inner.kind !== 'a-status' && inner.kind !== 'a-host'
    const id = inner.kind === 'msg' ? inner.id : undefined
    this.relay.send(to, frame, { push, store, ...(id ? { id } : {}) })
  }

  private printSafety(ownerPk: string): void {
    const [a, b] = formatSafetyNumber(safetyNumber(this.identity.publicKey, fromB64u(ownerPk)))
    console.log(
      `\n  ✓ Paired with your phone.\n` +
        `  Verify these digits match the ones under the host on your phone\n` +
        `  (open it → ⋯ → Verify safety number):\n\n` +
        `    ${a}\n    ${b}\n`,
    )
  }
}
