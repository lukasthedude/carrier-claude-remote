// One agent in the fleet: its own Carrier identity + relay socket + Engine,
// running in its own worktree/session. This is exactly the v1 single-agent stack
// (CarrierPeer + Engine), constructed per agent with the host's owner preset.

import { fromB64u, identityFromPrivateKey } from '../src/crypto'
import type { BridgeConfig } from './config'
import { Engine } from './engine'
import { CarrierPeer } from './peer'
import type { ClaudeRunner } from './runner'
import { AgentState, agentState, type AgentRecord, type HostState } from './state'

export class AgentRuntime {
  readonly peer: CarrierPeer
  private engine: Engine

  constructor(
    readonly rec: AgentRecord,
    host: HostState,
    config: BridgeConfig,
    runner: ClaudeRunner,
    onSignupGate: (code: string, msg: string) => void,
  ) {
    const identity = identityFromPrivateKey(fromB64u(rec.sk))
    const agentConfig: BridgeConfig = {
      ...config,
      projects: { [rec.project]: { repo: rec.cwd } },
      defaultProject: rec.project,
      model: rec.model,
    }
    this.peer = new CarrierPeer({
      identity,
      name: rec.name,
      relay: config.relay,
      signupCode: config.signupCode,
      private: config.private,
      caps: ['cc'],
      ownerPk: host.ownerPk, // the host's owner — agents never pin their own
      ...(rec.project ? { project: rec.project } : {}),
      ...(rec.branch ? { branch: rec.branch } : {}),
      onSignupGate,
      quiet: true,
    })
    this.engine = new Engine(this.peer, runner, agentConfig, new AgentState(rec, host))
    this.peer.handlers = this.engine
  }

  get pk(): string {
    return this.rec.pk
  }
  get state(): string {
    return agentState(this.rec.queue)
  }
  start(): void {
    this.peer.start()
    this.engine.start()
  }
  stop(): void {
    this.peer.stop()
  }
}
