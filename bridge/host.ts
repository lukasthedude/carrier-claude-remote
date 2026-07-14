// The host controller: owns the host Carrier identity (the control channel the
// phone pairs with) and the fleet of agents. Handles spawn/close/list from the
// owner, creates worktrees + agent identities, and announces the roster so the
// phone auto-adds each agent as its own chat.

import { generateIdentity, randomBytes, toB64u } from '../src/crypto'
import { AgentRuntime } from './agent'
import type { BridgeConfig } from './config'
import { CarrierPeer, type PeerHandlers } from './peer'
import type { ClaudeRunner } from './runner'
import { genBranch, type SessionManager } from './sessions'
import { agentState, type AgentRecord, type HostState } from './state'

export class HostController implements PeerHandlers {
  private host: CarrierPeer
  private agents = new Map<string, AgentRuntime>() // agent pk → runtime

  constructor(
    private state: HostState,
    private config: BridgeConfig,
    private runner: ClaudeRunner,
    private sessions: SessionManager,
    private onSignupGate: (code: string, msg: string) => void,
  ) {
    this.host = new CarrierPeer({
      identity: state.identity,
      name: config.name,
      relay: config.relay,
      signupCode: config.signupCode,
      private: config.private,
      caps: ['cc', 'host'],
      ownerPk: state.ownerPk,
      onOwnerPin: (pk) => state.setOwner(pk),
      onSignupGate,
    })
    this.host.handlers = this
    for (const rec of state.agents) if (!rec.archived) this.attachRuntime(rec) // restore the (live) fleet
  }

  start(): void {
    this.host.start()
    for (const a of this.agents.values()) a.start()
  }
  stop(): void {
    for (const a of this.agents.values()) a.stop()
    this.host.stop()
    this.state.save()
  }
  chatCode(): string {
    return this.host.chatCode()
  }
  get ownerPk(): string | null {
    return this.host.owner
  }

  private attachRuntime(rec: AgentRecord): AgentRuntime {
    const rt = new AgentRuntime(rec, this.state, this.config, this.runner, this.onSignupGate)
    this.agents.set(rec.pk, rt)
    return rt
  }

  // ---- PeerHandlers (host role) ----

  onOwnerConnected(): void {
    this.announceRoster()
  }
  onOwnerMessage(): void {
    // the host chat isn't for tasks — nudge toward creating an agent
    this.host.sendText('This is your Mac. Tap ＋ New agent to start one, then send it tasks.')
  }
  onSpawn(spawn: { project: string; branch?: string; attach?: string }): void {
    void this.spawn(spawn)
  }
  onClose(pk: string, archive?: boolean): void {
    void this.closeAgent(pk, archive)
  }
  onList(project: string): void {
    void this.sendSessionsFor(project)
  }

  // ---- fleet ops ----

  private async spawn(spawn: { project: string; branch?: string; attach?: string }): Promise<void> {
    const spec = this.config.projects[spawn.project]
    if (!spec) {
      this.host.sendText(`No project “${spawn.project}”. Configured: ${Object.keys(this.config.projects).join(', ') || '(none)'}`)
      return
    }
    let cwd: string
    let branch: string | undefined
    let worktree = false
    let sessionId: string | undefined
    let name: string
    try {
      if (spawn.attach) {
        if (this.sessionInUse(spawn.attach)) {
          this.host.sendText('That session is already running here — open its agent instead.')
          return
        }
        const info = await this.sessions.getSession(spawn.attach, spec)
        cwd = info?.cwd ?? spec.repo
        sessionId = spawn.attach
        branch = info?.branch
        name = info?.title ?? spawn.project
      } else {
        branch = spawn.branch || genBranch()
        const wt = await this.sessions.createWorktree(spec, branch)
        cwd = wt.path
        worktree = true
        name = `${spawn.project} · ${branch}`
      }
    } catch (e) {
      this.host.sendText(`Couldn't create the agent: ${(e as Error).message}`)
      return
    }
    const kp = generateIdentity()
    const rec: AgentRecord = {
      id: toB64u(randomBytes(6)),
      pk: toB64u(kp.publicKey),
      sk: toB64u(kp.privateKey),
      name: name.slice(0, 64),
      project: spawn.project,
      cwd,
      ...(branch ? { branch } : {}),
      worktree,
      model: this.config.model,
      ...(sessionId ? { sessionId } : {}),
      queue: [],
    }
    this.state.addAgent(rec)
    const rt = this.attachRuntime(rec)
    rt.start()
    this.announceRoster()
    // Attached to an existing conversation → backfill its recent transcript so
    // the phone chat opens right where the desktop left off. Once per agent
    // (histSent survives restarts); best-effort — the relay queues the frames
    // until the agent's socket is ready, and mailboxes them for an offline phone.
    if (sessionId && !rec.histSent) {
      void this.sessions.getSessionHistory(sessionId, spec).then((hist) => {
        if (!hist.length) return
        rt.peer.sendHist(sessionId, hist)
        rec.histSent = true
        this.state.save()
      })
    }
  }

  private async closeAgent(pk: string, archive = false): Promise<void> {
    const rt = this.agents.get(pk)
    if (!rt) return
    rt.stop()
    this.agents.delete(pk)
    // Archive = Conductor archive: the worktree goes either way (the branch and
    // session survive), but the record is kept and the Conductor workspace row
    // flips to 'archived' instead of vanishing.
    if (archive) this.state.archiveAgent(pk)
    else this.state.removeAgent(pk)
    if (rt.rec.worktree) {
      const spec = this.config.projects[rt.rec.project]
      if (spec) await this.sessions.removeWorktree(rt.rec.cwd, spec, archive)
    }
    this.announceRoster()
  }

  private async sendSessionsFor(project: string): Promise<void> {
    const spec = this.config.projects[project]
    if (!spec) return
    const list = await this.sessions.listSessions(spec)
    this.host.sendSessions(
      project,
      list.map((s) => ({ id: s.id, title: s.title, ...(s.branch ? { branch: s.branch } : {}), updatedAt: s.updatedAt })),
    )
  }

  private sessionInUse(sessionId: string): boolean {
    for (const rt of this.agents.values()) if (rt.rec.sessionId === sessionId) return true
    return false
  }

  private announceRoster(): void {
    const agents = [...this.agents.values()].map((rt) => ({
      pk: rt.pk,
      name: rt.rec.name,
      state: agentState(rt.rec.queue),
      ...(rt.rec.project ? { project: rt.rec.project } : {}),
      ...(rt.rec.branch ? { branch: rt.rec.branch } : {}),
    }))
    const projects = Object.keys(this.config.projects).map((name) => ({ name }))
    this.host.sendHostRoster(agents, projects)
  }
}
