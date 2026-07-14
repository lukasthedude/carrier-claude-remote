// Bridge configuration: a single JSON file in the bridge dir (default
// ~/.carrier-bridge, override with $CARRIER_BRIDGE_DIR). Written with sensible
// defaults on first run so a new user just fills in projects + a signup code.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface BridgeConfig {
  /** relay WebSocket URL (production by default) */
  relay: string
  /** the relay's invite/access code — needed only on the very first connect */
  signupCode: string
  /** the name this agent shows as, as a contact on your phone */
  name: string
  /** project name → absolute path; Claude runs each task in one of these */
  projects: Record<string, string>
  /** which project a bare task uses */
  defaultProject: string
  /** default model (alias or full id) */
  model: string
  /** models offered in the phone's picker */
  models: string[]
  /** 'default' = ask-on-risky via canUseTool; 'acceptEdits' = also auto-accept
   *  edits; 'bypassPermissions' = never ask (documented risk) */
  permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions'
  /** 'all' = forward Claude's intermediate notes; 'final' = only the result */
  progress: 'all' | 'final'
  /** most tasks to hold queued */
  maxQueue: number
  /** hide the bridge's presence from relay watchers (hello priv) */
  private: boolean
  /** 'sdk' = drive Claude Code; 'fake' = deterministic stub (tests) */
  runner: 'sdk' | 'fake'
}

const DEFAULTS: BridgeConfig = {
  relay: 'wss://thecarrier.org/ws',
  signupCode: '',
  name: 'Claude · Mac',
  projects: {},
  defaultProject: '',
  model: 'sonnet',
  models: ['opus', 'sonnet', 'haiku'],
  permissionMode: 'default',
  progress: 'all',
  maxQueue: 20,
  private: false,
  runner: 'sdk',
}

/** The bridge state dir (created 0700). All state — identity, config, queue. */
export function bridgeDir(): string {
  const dir = process.env['CARRIER_BRIDGE_DIR'] || join(homedir(), '.carrier-bridge')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/** Load config.json, writing defaults on first run. Normalizes the default
 *  project to a real one so the engine always has a cwd to fall back to. */
export function loadConfig(dir: string): BridgeConfig {
  const path = join(dir, 'config.json')
  if (!existsSync(path)) {
    writeFileSync(path, JSON.stringify(DEFAULTS, null, 2), { mode: 0o600 })
    return { ...DEFAULTS }
  }
  let raw: Partial<BridgeConfig> = {}
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<BridgeConfig>
  } catch (e) {
    console.error(`[config] ${path} is not valid JSON (${(e as Error).message}); using defaults`)
  }
  const cfg: BridgeConfig = { ...DEFAULTS, ...raw }
  const names = Object.keys(cfg.projects)
  if (!cfg.defaultProject || !cfg.projects[cfg.defaultProject]) cfg.defaultProject = names[0] ?? ''
  if (!Array.isArray(cfg.models) || cfg.models.length === 0) cfg.models = DEFAULTS.models
  return cfg
}

/** Resolve a project name to a working directory, falling back to the default
 *  project and finally the process cwd (so a zero-config run still works). */
export function projectCwd(cfg: BridgeConfig, project?: string): string {
  const name = project && cfg.projects[project] ? project : cfg.defaultProject
  return (name && cfg.projects[name]) || process.cwd()
}
