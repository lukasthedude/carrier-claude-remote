// The host controller: owns the host Carrier identity (the control channel the
// phone pairs with) and the fleet of agents. Handles spawn/close/list from the
// owner, creates worktrees + agent identities, and announces the roster so the
// phone auto-adds each agent as its own chat.

import { MAX_HOST_AGENTS } from '../src/protocol'
import { generateIdentity, randomBytes, toB64u } from '../src/crypto'
import { AgentRuntime } from './agent'
import type { BridgeConfig, ProjectSpec } from './config'
import { CarrierPeer, type PeerHandlers } from './peer'
import type { ClaudeRunner } from './runner'
import { genBranch, type ConductorWorkspace, type SessionManager } from './sessions'
import { agentState, type AgentRecord, type HostState } from './state'

const MIRROR_POLL_MS = 45_000

export class HostController implements PeerHandlers {
  private host: CarrierPeer
  private agents = new Map<string, AgentRuntime>() // agent pk → runtime
  private mirrorTimer: ReturnType<typeof setInterval> | null = null
  private mirroring = false

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
    // The phone's list MIRRORS the Conductor sidebar: pick up workspaces made
    // on the desktop (and archive ones retired there) without any phone action.
    void this.syncMirror()
    this.mirrorTimer = setInterval(() => void this.syncMirror(), MIRROR_POLL_MS)
  }
  stop(): void {
    if (this.mirrorTimer) clearInterval(this.mirrorTimer)
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
    // A MIRRORED agent is a view of a desktop workspace — the workspace is the
    // source of truth, so a plain close degrades to archive (deleting desktop
    // work from the phone is not a thing; the mirror would resurrect it anyway).
    if (rt.rec.conductorWs) archive = true
    rt.stop()
    this.agents.delete(pk)
    // Archive = Conductor archive: the worktree goes either way (the branch and
    // session survive), but the record is kept and the Conductor workspace row
    // flips to 'archived' instead of vanishing.
    if (archive) this.state.archiveAgent(pk)
    else this.state.removeAgent(pk)
    if (rt.rec.worktree || rt.rec.conductorWs) {
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
    const live = [...this.agents.values()].map((rt) => ({
      pk: rt.pk,
      name: rt.rec.name,
      state: agentState(rt.rec.queue),
      ...(rt.rec.project ? { project: rt.rec.project } : {}),
      ...(rt.rec.branch ? { branch: rt.rec.branch } : {}),
    }))
    // Archived agents ride along with state:'archived' (a loose enum value) so
    // the phone can park a workspace archived ON THE DESKTOP without ever
    // having seen a swipe — old phones just render an odd state chip.
    const archived = this.state.agents
      .filter((a) => a.archived)
      .map((a) => ({
        pk: a.pk,
        name: a.name,
        state: 'archived',
        ...(a.project ? { project: a.project } : {}),
        ...(a.branch ? { branch: a.branch } : {}),
      }))
    const agents = [...live, ...archived].slice(0, MAX_HOST_AGENTS)
    const projects = Object.keys(this.config.projects).map((name) => ({ name }))
    this.host.sendHostRoster(agents, projects)
  }

  // ---- Conductor mirror ----

  /** One reconcile pass: every live Conductor workspace appears as an agent
   *  (named like the sidebar, session backfilled); workspaces archived on the
   *  desktop archive their mirrored agent here. Best-effort + reentrancy-safe. */
  private async syncMirror(): Promise<void> {
    if (this.mirroring) return
    this.mirroring = true
    try {
      let changed = false
      for (const [project, spec] of Object.entries(this.config.projects)) {
        const wss = await this.sessions.listWorkspaces(spec)
        if (!wss.length) continue
        const byCwd = new Map(this.state.agents.map((a) => [a.cwd, a]))
        let sessions: { id: string; title: string }[] | null = null // lazy, one list per project
        for (const ws of wss) {
          const rec = byCwd.get(ws.path)
          if (!ws.archived && !rec) {
            if (this.state.agents.filter((a) => !a.archived).length >= MAX_HOST_AGENTS) continue
            let name = ws.name
            if (!name && ws.sessionId) {
              sessions ??= await this.sessions.listSessions(spec)
              name = sessions.find((s) => s.id === ws.sessionId)?.title ?? null
            }
            name ||= ws.branch?.split('/').pop() || ws.path.split('/').pop() || project
            this.adoptWorkspace(project, spec, ws, name)
            changed = true
          } else if (rec) {
            if (ws.archived && !rec.archived) {
              // archived on the desktop → archive the mirror (stop + park)
              this.agents.get(rec.pk)?.stop()
              this.agents.delete(rec.pk)
              this.state.archiveAgent(rec.pk)
              changed = true
            } else if (!ws.archived && ws.name && rec.name !== ws.name) {
              rec.name = ws.name.slice(0, 64) // renamed in Conductor → phone follows
              this.state.save()
              changed = true
            }
          }
        }
      }
      if (changed) this.announceRoster()
    } catch {
      /* polling is best-effort; the next tick retries */
    } finally {
      this.mirroring = false
    }
  }

  /** Mint an agent for an existing Conductor workspace (no new worktree). */
  private adoptWorkspace(project: string, spec: ProjectSpec, ws: ConductorWorkspace, name: string): void {
    const kp = generateIdentity()
    const rec: AgentRecord = {
      id: toB64u(randomBytes(6)),
      pk: toB64u(kp.publicKey),
      sk: toB64u(kp.privateKey),
      name: name.slice(0, 64),
      project,
      cwd: ws.path,
      ...(ws.branch ? { branch: ws.branch } : {}),
      worktree: false,
      model: this.config.model,
      ...(ws.sessionId ? { sessionId: ws.sessionId } : {}),
      conductorWs: ws.id,
      queue: [],
    }
    this.state.addAgent(rec)
    const rt = this.attachRuntime(rec)
    rt.start()
    if (rec.sessionId && !rec.histSent) {
      void this.sessions.getSessionHistory(rec.sessionId, spec).then((hist) => {
        if (!hist.length) return
        rt.peer.sendHist(rec.sessionId!, hist)
        rec.histSent = true
        this.state.save()
      })
    }
  }
}
