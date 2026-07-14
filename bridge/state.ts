// Durable bridge state: the identity keypair (identity.json, 0600 — it IS the
// account), the pinned owner + per-project Claude session ids (state.json), and
// the task queue (queue.json, so a restart never loses queued work).

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fromB64u, generateIdentity, identityFromPrivateKey, toB64u, type Identity } from '../src/crypto'
import { JsonStore } from './persist'

export type TaskState = 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'cancelled'

export interface Task {
  /** the owner's original msg id — lets the phone tie status to its bubble */
  id: string
  text: string
  project: string
  model: string
  state: TaskState
  createdTs: number
  /** short label for the phone's queue/status (first line, trimmed) */
  title: string
}

interface PersistedState {
  ownerPk: string | null
  /** project name → Claude Code session id, for conversational continuity */
  sessions: Record<string, string>
}

export function taskTitle(text: string): string {
  const firstLine = text.split('\n')[0]?.trim() ?? ''
  return firstLine.length > 80 ? firstLine.slice(0, 79) + '…' : firstLine || '(task)'
}

export class BridgeState {
  readonly identity: Identity
  queue: Task[]
  private s: PersistedState
  private stateStore: JsonStore<PersistedState>
  private queueStore: JsonStore<Task[]>

  constructor(dir: string) {
    this.identity = loadOrCreateIdentity(dir)
    this.stateStore = new JsonStore<PersistedState>(dir, 'state.json')
    this.s = this.stateStore.load({ ownerPk: null, sessions: {} })
    this.stateStore.bind(() => this.s)
    this.queueStore = new JsonStore<Task[]>(dir, 'queue.json')
    this.queue = this.queueStore.load([])
    this.queueStore.bind(() => this.queue)
  }

  get ownerPk(): string | null {
    return this.s.ownerPk
  }
  setOwner(pk: string): void {
    this.s.ownerPk = pk
    this.stateStore.flushSync()
  }
  clearOwner(): void {
    this.s.ownerPk = null
    this.s.sessions = {}
    this.stateStore.flushSync()
    // Drop the queue too — a newly paired owner must not inherit the previous
    // owner's pending tasks.
    this.queue = []
    this.saveQueue()
  }

  session(project: string): string | undefined {
    return this.s.sessions[project]
  }
  setSession(project: string, id: string): void {
    this.s.sessions[project] = id
    this.stateStore.markDirty()
  }
  clearSession(project: string): void {
    delete this.s.sessions[project]
    this.stateStore.markDirty()
  }

  /** Persist the queue NOW (before we tell the relay we took custody). */
  saveQueue(): void {
    this.queueStore.flushSync()
  }

  flush(): void {
    this.stateStore.flushSync()
    this.queueStore.flushSync()
  }
}

function loadOrCreateIdentity(dir: string): Identity {
  const path = join(dir, 'identity.json')
  if (existsSync(path)) {
    const j = JSON.parse(readFileSync(path, 'utf8')) as { privateKey: string }
    return identityFromPrivateKey(fromB64u(j.privateKey))
  }
  const id = generateIdentity()
  writeFileSync(
    path,
    JSON.stringify({ publicKey: toB64u(id.publicKey), privateKey: toB64u(id.privateKey) }, null, 2),
    { mode: 0o600 },
  )
  return id
}
