// Durable host state: the host identity keypair (identity.json, 0600 — it IS the
// account), the pinned owner, and the AGENT REGISTRY (host.json) — each agent is
// its own keypair + worktree + Claude session + task queue. One host, many
// agents (Conductor-style).

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

/** The persistence surface the Engine needs — AgentState satisfies it. */
export interface EngineState {
  queue: Task[]
  session(project: string): string | undefined
  setSession(project: string, id: string): void
  clearSession(project: string): void
  saveQueue(): void
  /** persisted per-agent preferences; undefined = the config/SDK default */
  readonly mode: string | undefined
  readonly effort: string | undefined
  setPrefs(p: { mode?: string; effort?: string }): void
}

/** One agent in the fleet: its own identity, worktree, Claude session, queue. */
export interface AgentRecord {
  id: string
  /** agent public / private key (b64u) — its own Carrier identity */
  pk: string
  sk: string
  name: string
  project: string
  /** absolute working directory (a git worktree, or the project dir for attach) */
  cwd: string
  branch?: string
  /** true if we created a git worktree for it that should be removed on close */
  worktree?: boolean
  model: string
  /** Claude Code session id — from an attach, or captured on first run */
  sessionId?: string
  /** transcript backfill already sent to the phone (never resend on restart) */
  histSent?: boolean
  /** archived (Conductor-style): stopped, worktree removed, record kept */
  archived?: boolean
  /** Conductor workspace id this agent MIRRORS (created by the desktop app);
   *  the workspace is the source of truth — close degrades to archive. */
  conductorWs?: string
  /** permission mode override ('default'|'plan'|…); unset = config default */
  mode?: string
  /** reasoning effort ('low'…'max'); unset = the SDK's model default */
  effort?: string
  queue: Task[]
}

interface HostPersisted {
  ownerPk: string | null
  agents: AgentRecord[]
}

export function taskTitle(text: string): string {
  const firstLine = text.split('\n')[0]?.trim() ?? ''
  return firstLine.length > 80 ? firstLine.slice(0, 79) + '…' : firstLine || '(task)'
}

export class HostState {
  readonly identity: Identity
  private s: HostPersisted
  private store: JsonStore<HostPersisted>

  constructor(dir: string) {
    this.identity = loadOrCreateIdentity(dir)
    this.store = new JsonStore<HostPersisted>(dir, 'host.json')
    this.s = this.store.load({ ownerPk: null, agents: [] })
    for (const a of this.s.agents) if (!a.queue) a.queue = []
    this.store.bind(() => this.s)
  }

  get ownerPk(): string | null {
    return this.s.ownerPk
  }
  setOwner(pk: string): void {
    this.s.ownerPk = pk
    this.store.flushSync()
  }
  clearOwner(): void {
    this.s.ownerPk = null
    this.s.agents = [] // a newly paired owner starts with an empty fleet
    this.store.flushSync()
  }

  get agents(): AgentRecord[] {
    return this.s.agents
  }
  addAgent(a: AgentRecord): void {
    this.s.agents.push(a)
    this.store.flushSync()
  }
  removeAgent(pk: string): void {
    this.s.agents = this.s.agents.filter((a) => a.pk !== pk)
    this.store.flushSync()
  }
  /** Keep the record (branch, session id, history of what it was) — just mark
   *  it archived so it never gets a runtime or a roster slot again. */
  archiveAgent(pk: string): void {
    const a = this.s.agents.find((x) => x.pk === pk)
    if (a) {
      a.archived = true
      this.store.flushSync()
    }
  }

  save(): void {
    this.store.flushSync()
  }
  markDirty(): void {
    this.store.markDirty()
  }
}

/** EngineState over one AgentRecord, persisting through the host store. */
export class AgentState implements EngineState {
  constructor(
    private rec: AgentRecord,
    private host: HostState,
  ) {
    if (!rec.queue) rec.queue = []
  }
  get queue(): Task[] {
    return this.rec.queue
  }
  set queue(q: Task[]) {
    this.rec.queue = q
  }
  session(_project: string): string | undefined {
    return this.rec.sessionId
  }
  setSession(_project: string, id: string): void {
    this.rec.sessionId = id
    this.host.markDirty()
  }
  clearSession(_project: string): void {
    this.rec.sessionId = undefined
    this.host.markDirty()
  }
  get mode(): string | undefined {
    return this.rec.mode
  }
  get effort(): string | undefined {
    return this.rec.effort
  }
  setPrefs(p: { mode?: string; effort?: string }): void {
    if (p.mode !== undefined) this.rec.mode = p.mode
    if (p.effort !== undefined) this.rec.effort = p.effort
    this.host.save()
  }
  saveQueue(): void {
    this.host.save()
  }
}

/** Derive the coarse agent state (idle|busy|waiting) for the roster from a queue. */
export function agentState(queue: Task[]): string {
  if (queue.some((t) => t.state === 'waiting')) return 'waiting'
  if (queue.some((t) => t.state === 'running' || t.state === 'queued')) return 'busy'
  return 'idle'
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
