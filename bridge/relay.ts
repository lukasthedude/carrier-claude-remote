// The bridge's relay client: one long-lived WebSocket that speaks the exact v2
// contract the PWA does (hello → sealed-box challenge → verify → ready), takes
// custody by got'ing only after the handler has persisted, and reconnects with
// backoff. Transport only — it moves opaque encrypted frame strings; peer.ts
// does the crypto. Modeled on src/relay.ts + test/relay.test.ts.

import WebSocket from 'ws'
import { fromB64u, sealOpen, toB64u, type Identity } from '../src/crypto'

export interface RelayHandlers {
  onReady(): void
  /** Deliver an inbound frame; resolve only once it's durably handled, then the
   *  relay is told we took custody (got). */
  onFrame(from: string, data: string, id?: string): void | Promise<void>
  onSent(id: string): void
  onSignupGate(code: string, msg: string): void
  onConnectionChange(connected: boolean): void
}

const PING_MS = 25_000
const BACKOFF_START = 1000
const BACKOFF_FACTOR = 1.7
const BACKOFF_MAX = 15_000

interface Queued {
  to: string
  data: string
  push: boolean
  store: boolean
  id?: string
}

export class BridgeRelay {
  private ws: WebSocket | null = null
  private pk: string
  private connected = false
  private closing = false
  private backoff = BACKOFF_START
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private queue: Queued[] = []
  private signupCode: string

  constructor(
    private url: string,
    private identity: Identity,
    signupCode: string,
    private priv: boolean,
    private handlers: RelayHandlers,
  ) {
    this.pk = toB64u(identity.publicKey)
    this.signupCode = signupCode
  }

  start(): void {
    this.closing = false
    this.open()
  }

  stop(): void {
    this.closing = true
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    try {
      this.ws?.close()
    } catch {
      /* already closed */
    }
  }

  /** Enqueue a frame; sent immediately if connected, else on next ready. */
  send(to: string, data: string, opts: { push?: boolean; store?: boolean; id?: string } = {}): void {
    const item: Queued = { to, data, push: !!opts.push, store: opts.store !== false, ...(opts.id ? { id: opts.id } : {}) }
    this.queue.push(item)
    if (this.queue.length > 512) this.queue.shift() // safety cap; oldest goes first
    if (this.connected) this.drain()
  }

  private open(): void {
    const ws = new WebSocket(this.url)
    this.ws = ws
    ws.on('open', () => {
      const hello: Record<string, unknown> = { t: 'hello', pk: this.pk, v: 2, fg: true }
      if (this.signupCode) hello['signup'] = this.signupCode
      if (this.priv) hello['priv'] = true
      this.raw(hello)
    })
    ws.on('message', (buf: WebSocket.RawData) => this.onMessage(String(buf)))
    ws.on('close', () => this.onClose())
    ws.on('error', () => {
      /* 'close' follows; reconnect is handled there */
    })
  }

  private onMessage(text: string): void {
    let m: Record<string, unknown>
    try {
      m = JSON.parse(text) as Record<string, unknown>
    } catch {
      return
    }
    switch (m['t']) {
      case 'challenge': {
        try {
          const opened = sealOpen(fromB64u(m['c'] as string), this.identity.publicKey, this.identity.privateKey)
          this.raw({ t: 'verify', open: toB64u(opened) })
        } catch {
          /* can't open — not our challenge; the relay will time us out */
        }
        return
      }
      case 'ready': {
        this.connected = true
        this.backoff = BACKOFF_START
        this.signupCode = '' // consumed once; never resend it
        this.handlers.onConnectionChange(true)
        this.startPing()
        this.drain()
        this.handlers.onReady()
        return
      }
      case 'frame': {
        const from = m['from'] as string
        const data = m['data'] as string
        const id = typeof m['id'] === 'string' ? m['id'] : undefined
        void this.deliver(from, data, id)
        return
      }
      case 'mail': {
        for (const it of (m['items'] as Record<string, unknown>[]) ?? []) {
          const id = typeof it['id'] === 'string' ? (it['id'] as string) : undefined
          void this.deliver(it['from'] as string, it['data'] as string, id)
        }
        return
      }
      case 'sent': {
        if (typeof m['id'] === 'string') this.handlers.onSent(m['id'])
        return
      }
      case 'err': {
        const code = m['code']
        if (code === 'signup' || code === 'signup-bad' || code === 'signup-limit') {
          this.handlers.onSignupGate(String(code), String(m['msg'] ?? ''))
        }
        return
      }
      default:
        return // presence/pong/ice — nothing to do
    }
  }

  /** Hand a frame to the app, then take custody (got) only once it settled. */
  private async deliver(from: string, data: string, id?: string): Promise<void> {
    try {
      await this.handlers.onFrame(from, data, id)
    } catch (e) {
      console.error(`[relay] frame handler threw: ${(e as Error).message}`)
      return // don't got — let the relay redeliver
    }
    if (id) this.raw({ t: 'got', id })
  }

  private drain(): void {
    if (!this.connected || !this.ws) return
    for (const q of this.queue.splice(0)) {
      this.raw({ t: 'send', to: q.to, data: q.data, push: q.push, store: q.store, ...(q.id ? { id: q.id } : {}) })
    }
  }

  private startPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = setInterval(() => this.raw({ t: 'ping' }), PING_MS)
  }

  private onClose(): void {
    this.connected = false
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.handlers.onConnectionChange(false)
    if (this.closing) return
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => this.open(), this.backoff)
    this.backoff = Math.min(this.backoff * BACKOFF_FACTOR, BACKOFF_MAX)
  }

  private raw(m: unknown): void {
    try {
      this.ws?.send(JSON.stringify(m))
    } catch {
      /* socket gone; reconnect will replay the queue */
    }
  }
}
