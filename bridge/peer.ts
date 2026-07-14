// The Carrier-protocol layer: turns the relay's opaque frames into decrypted
// inner messages and back, pins the owner (the first phone to pair), drops
// everyone else, and exposes the send verbs the engine needs (chunked replies,
// receipts, typing, agent status/questions). No task logic lives here.

import { formatSafetyNumber, fromB64u, randomBytes, safetyNumber, toB64u, utf8Encode, type Identity } from '../src/crypto'
import { decodeFrame, encodeFrame, type Inner } from '../src/protocol'
import { chunkText } from './chunk'
import { BridgeRelay } from './relay'
import type { BridgeConfig } from './config'
import type { AskQuestion } from './runner'
import type { BridgeState } from './state'

// One canonical question shape, shared with the runner (which produces it) so
// the two can't silently diverge.
export type AgentQuestion = AskQuestion

export interface PeerHandlers {
  /** the owner sent a line (a task or a command or an answer) */
  onOwnerMessage(text: string, msgId: string): void
  /** the owner sent an a-ctl (model switch / cancel / status request); `ts` is
   *  the send time, so the engine can ignore a mailbox-stale cancel */
  onCtl(ctl: { model?: string; cancel?: string; sync?: true; ts: number }): void
  /** the owner's phone (re)connected — re-announce + emit a fresh status */
  onOwnerConnected(): void
}

export class CarrierPeer {
  handlers: PeerHandlers | null = null
  private relay: BridgeRelay
  private identity: Identity
  readonly myPk: string

  constructor(
    private state: BridgeState,
    private config: BridgeConfig,
    private onSignupGate: (code: string, msg: string) => void,
  ) {
    this.identity = state.identity
    this.myPk = toB64u(this.identity.publicKey)
    this.relay = new BridgeRelay(config.relay, this.identity, config.signupCode, config.private, {
      onReady: () => this.onReady(),
      onFrame: (from, data) => this.onFrame(from, data),
      onSent: () => {},
      onSignupGate: (code, msg) => this.onSignupGate(code, msg),
      onConnectionChange: (c) => console.log(c ? '[relay] connected' : '[relay] disconnected — reconnecting…'),
    })
  }

  start(): void {
    this.relay.start()
  }
  stop(): void {
    this.relay.stop()
  }

  /** `${pk}.${b64u(name)}` — paste this into Carrier's "Add a friend". */
  chatCode(): string {
    return `${this.myPk}.${toB64u(utf8Encode(this.config.name))}`
  }

  private hello(): Inner {
    return { kind: 'hello', name: this.config.name, pk: this.myPk, caps: ['cc'] }
  }

  private onReady(): void {
    const owner = this.state.ownerPk
    if (owner) {
      this.sendInner(owner, this.hello()) // remind the phone who we are + our caps
      this.handlers?.onOwnerConnected()
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

    const owner = this.state.ownerPk
    if (!owner) {
      // Unpaired: the first genuine 1:1 hello becomes the owner, forever.
      if (inner.kind === 'hello' && !inner.gid) {
        this.state.setOwner(from)
        this.sendInner(from, this.hello())
        this.printSafety(from)
        this.handlers?.onOwnerConnected()
      }
      return
    }
    if (from !== owner) return // pinned — ignore every other sender, silently

    switch (inner.kind) {
      case 'hello':
        this.sendInner(from, this.hello())
        this.handlers?.onOwnerConnected()
        return
      case 'msg':
        this.sendAck([inner.id]) // phone shows "Delivered" immediately
        this.handlers?.onOwnerMessage(inner.text, inner.id)
        return
      case 'a-ctl':
        this.handlers?.onCtl({
          ts: inner.ts,
          ...(inner.model ? { model: inner.model } : {}),
          ...(inner.cancel ? { cancel: inner.cancel } : {}),
          ...(inner.sync ? { sync: true } : {}),
        })
        return
      default:
        return // ack/read/typing/file/call/group — nothing to do
    }
  }

  // ---- send verbs (engine calls these; owner is resolved internally) ----

  /** Send text to the owner, chunked to fit MAX_TEXT. Returns the first msg id. */
  sendText(text: string): string {
    const owner = this.state.ownerPk
    if (!owner || !text.trim()) return ''
    let firstId = ''
    let ts = Date.now()
    for (const chunk of chunkText(text)) {
      if (!chunk) continue
      const id = toB64u(randomBytes(8))
      if (!firstId) firstId = id
      this.sendInner(owner, { kind: 'msg', id, ts, text: chunk })
      ts += 1 // strictly increasing so chunks stay ordered on the phone
    }
    return firstId
  }

  sendStatus(status: { state: string; model: string; models: string[]; queue: { id: string; title: string; state: string }[] }): void {
    const owner = this.state.ownerPk
    if (!owner) return
    this.sendInner(owner, { kind: 'a-status', ts: Date.now(), ...status })
  }

  sendAsk(ask: string, msgId: string, questions: AgentQuestion[]): void {
    const owner = this.state.ownerPk
    if (!owner) return
    // Clamp to the protocol's a-ask limits so a long question can never make the
    // phone's validateInner throw and drop the whole (chips) frame — the full
    // text still rides the companion msg. Must have ≥2 options to stay valid.
    const clamped: AgentQuestion[] = questions.slice(0, 4).map((q) => ({
      q: q.q.slice(0, 500),
      ...(q.header ? { header: q.header.slice(0, 16) } : {}),
      ...(q.multi ? { multi: true as const } : {}),
      options: q.options.slice(0, 8).map((o) => ({ label: o.label.slice(0, 120), ...(o.desc ? { desc: o.desc.slice(0, 250) } : {}) })),
    }))
    if (clamped.some((q) => q.options.length < 2)) return // no tappable chips — the companion msg covers it
    this.sendInner(owner, { kind: 'a-ask', ask, msgId, questions: clamped })
  }

  sendTyping(on: boolean): void {
    const owner = this.state.ownerPk
    if (!owner) return
    this.sendInner(owner, { kind: 'typing', on })
  }

  sendAck(ids: string[]): void {
    const owner = this.state.ownerPk
    if (!owner) return
    this.sendInner(owner, { kind: 'ack', ids })
  }

  private sendInner(to: string, inner: Inner): void {
    let frame: string
    try {
      frame = encodeFrame(inner, fromB64u(to), this.identity.privateKey)
    } catch {
      return // bad key
    }
    const push = inner.kind === 'msg' // only real messages wake the phone
    const store = inner.kind !== 'typing' && inner.kind !== 'a-status' // volatile ones aren't mailboxed
    const id = inner.kind === 'msg' ? inner.id : undefined
    this.relay.send(to, frame, { push, store, ...(id ? { id } : {}) })
  }

  private printSafety(ownerPk: string): void {
    const [a, b] = formatSafetyNumber(safetyNumber(this.identity.publicKey, fromB64u(ownerPk)))
    console.log(
      `\n  ✓ Paired with your phone.\n` +
        `  Verify these digits match the ones under the agent on your phone\n` +
        `  (open the chat → ⋯ → Verify safety number):\n\n` +
        `    ${a}\n    ${b}\n`,
    )
  }
}
