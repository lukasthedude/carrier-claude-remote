// Session + worktree manager: lists resumable Claude Code sessions (so the phone
// can "continue this exact conversation") and creates/removes git worktrees (so
// each new agent is isolated, Conductor-style). Real impl drives the SDK + git;
// FakeSessions backs the tests (no Claude login, no real git).

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { randomBytes, toB64u } from '../src/crypto'
import type { ProjectSpec } from './config'

const exec = promisify(execFile)

// Conductor (conductor.build) integration on macOS: it keeps a SQLite registry
// of workspaces and shows one in its sidebar ONLY if there's a row for it — so a
// phone-spawned worktree, placed in Conductor's own layout AND registered here,
// appears as a native workspace on the desktop. All best-effort via the system
// `sqlite3` CLI (no npm dep, no Node-version issues); any failure falls back to
// a plain sibling worktree and never blocks spawning. NOTE: the running app
// doesn't watch the DB, so a newly-added workspace shows after Conductor is
// reopened.
const CONDUCTOR_DB = join(homedir(), 'Library', 'Application Support', 'com.conductor.app', 'conductor.db')
const CONDUCTOR_WORKSPACES = join(homedir(), 'conductor', 'workspaces')
// Folder names for new workspaces (Conductor uses city names).
const CITY_POOL =
  'osaka lima cairo oslo porto kyoto nairobi bogota tbilisi dakar hanoi quito riga malmo cusco leeds ghent turin bergen galway naples pune mendoza antwerp utrecht salzburg cork aarhus tallinn vilnius bilbao nantes rennes leipzig bologna verona padua modena zadar split'.split(
    ' ',
  )
/** Escape a value for inlining into a `sqlite3` statement (paths/ids only). */
const sqlStr = (s: string): string => `'${String(s).replace(/'/g, "''")}'`

export interface SessionInfo {
  id: string
  title: string
  branch?: string
  updatedAt: number
  cwd: string
}

export interface SessionManager {
  listSessions(spec: ProjectSpec): Promise<SessionInfo[]>
  getSession(id: string, spec: ProjectSpec): Promise<SessionInfo | undefined>
  createWorktree(spec: ProjectSpec, branch: string): Promise<{ path: string }>
  removeWorktree(cwd: string, spec: ProjectSpec): Promise<void>
}

const slug = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 40) || 'agent'
export const genBranch = () => `cc/${toB64u(randomBytes(4)).toLowerCase().replace(/[^a-z0-9]/g, '')}`

/** Real manager — Claude Agent SDK for sessions, `git worktree` for isolation. */
export class SdkSessions implements SessionManager {
  private readonly conductor: boolean
  private readonly dbPath: string
  private readonly wsRoot: string
  constructor(opts: { conductor?: boolean; dbPath?: string; wsRoot?: string } = {}) {
    this.conductor = opts.conductor !== false // undefined/true = auto-on
    this.dbPath = opts.dbPath ?? CONDUCTOR_DB
    this.wsRoot = opts.wsRoot ?? CONDUCTOR_WORKSPACES
  }

  // computed so TS/CI don't need the optional SDK installed
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async sdk(): Promise<any> {
    return import(/* @vite-ignore */ ['@anthropic-ai', 'claude-agent-sdk'].join('/'))
  }

  async listSessions(spec: ProjectSpec): Promise<SessionInfo[]> {
    try {
      const sdk = await this.sdk()
      // includeProgrammatic:true is ESSENTIAL — Conductor sessions are sdk-ts and
      // would otherwise be hidden; includeWorktrees:true covers sibling worktrees.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows: any[] = await sdk.listSessions({ dir: spec.repo, includeProgrammatic: true, includeWorktrees: true })
      return rows
        .map((r) => ({
          id: String(r.sessionId),
          title: String(r.customTitle || r.summary || r.firstPrompt || 'session').slice(0, 120),
          ...(r.gitBranch ? { branch: String(r.gitBranch).slice(0, 120) } : {}),
          updatedAt: Number(r.lastModified) || Date.now(),
          cwd: String(r.cwd || spec.repo),
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt)
    } catch (e) {
      console.error(`[sessions] list failed: ${(e as Error).message}`)
      return []
    }
  }

  async getSession(id: string, spec: ProjectSpec): Promise<SessionInfo | undefined> {
    return (await this.listSessions(spec)).find((s) => s.id === id)
  }

  async createWorktree(spec: ProjectSpec, branch: string): Promise<{ path: string }> {
    // Conductor repo → put the worktree in Conductor's layout and register it.
    const cond = await this.conductorRepo(spec.repo)
    if (cond) {
      const city = await this.freeCity(cond.id, cond.dir)
      const path = join(cond.dir, city)
      await exec('git', ['-C', spec.repo, 'fetch', 'origin'], { timeout: 60_000 }).catch(() => {})
      await exec('git', ['-C', spec.repo, 'worktree', 'add', '-b', branch, path, spec.base || `origin/${cond.defaultBranch}`], { timeout: 60_000 })
      if (!(await this.registerConductor(cond, city, branch, path)))
        console.error('[sessions] worktree created but Conductor registration failed — it works; it may only show after you reopen Conductor')
      return { path }
    }
    // plain sibling worktree (no Conductor, or disabled)
    const base = spec.base || 'origin/main'
    const wtDir = spec.worktreesDir || dirname(spec.repo)
    const path = join(wtDir, `${basename(spec.repo)}-${slug(branch)}-${toB64u(randomBytes(3)).toLowerCase().replace(/[^a-z0-9]/g, '')}`)
    await exec('git', ['-C', spec.repo, 'fetch', 'origin'], { timeout: 60_000 }).catch(() => {})
    await exec('git', ['-C', spec.repo, 'worktree', 'add', '-b', branch, path, base], { timeout: 60_000 })
    return { path }
  }

  async removeWorktree(cwd: string, spec: ProjectSpec): Promise<void> {
    await exec('git', ['-C', spec.repo, 'worktree', 'remove', '--force', cwd], { timeout: 30_000 }).catch((e) =>
      console.error(`[sessions] worktree remove failed: ${(e as Error).message}`),
    )
    // drop the Conductor registry row if this was a Conductor-managed worktree
    if (this.conductor && existsSync(this.dbPath) && cwd.startsWith(this.wsRoot + '/'))
      await exec('sqlite3', [this.dbPath, `PRAGMA busy_timeout=5000; DELETE FROM workspaces WHERE workspace_path=${sqlStr(cwd)};`], { timeout: 8_000 }).catch(() => {})
  }

  /** If this repo is registered in Conductor, return its id + default branch +
   *  the workspaces dir it uses. Best-effort; null → use a sibling worktree. */
  private async conductorRepo(repoRoot: string): Promise<{ id: string; defaultBranch: string; dir: string } | null> {
    if (!this.conductor || !existsSync(this.dbPath)) return null
    try {
      const { stdout } = await exec('sqlite3', ['-json', this.dbPath, `SELECT id, name, default_branch FROM repos WHERE root_path=${sqlStr(repoRoot)} LIMIT 1;`], { timeout: 8_000 })
      const row = (JSON.parse(stdout || '[]') as Array<{ id: string; name: string; default_branch: string }>)[0]
      if (!row?.id) return null
      return { id: String(row.id), defaultBranch: String(row.default_branch || 'main'), dir: join(this.wsRoot, String(row.name || basename(repoRoot))) }
    } catch {
      return null
    }
  }

  /** An unused workspace folder name for this repo (avoids existing rows + dirs). */
  private async freeCity(repoId: string, dir: string): Promise<string> {
    const used = new Set<string>()
    try {
      const { stdout } = await exec('sqlite3', ['-json', this.dbPath, `SELECT directory_name FROM workspaces WHERE repository_id=${sqlStr(repoId)};`], { timeout: 8_000 })
      for (const r of JSON.parse(stdout || '[]') as Array<{ directory_name: string }>) used.add(String(r.directory_name))
    } catch {
      /* best-effort — a collision just means a suffixed name below */
    }
    for (const c of CITY_POOL) if (!used.has(c) && !existsSync(join(dir, c))) return c
    return `${CITY_POOL[0] ?? 'agent'}-${toB64u(randomBytes(2)).toLowerCase().replace(/[^a-z0-9]/g, '')}`
  }

  /** Insert the `workspaces` row so Conductor lists it (only id + repository_id +
   *  path are load-bearing; the rest just makes it render like a live workspace). */
  private async registerConductor(repo: { id: string; defaultBranch: string }, city: string, branch: string, path: string): Promise<boolean> {
    try {
      const cols = 'id, repository_id, directory_name, branch, workspace_path, state, derived_status, intended_target_branch, initialization_parent_branch, permission_level, created_at, updated_at'
      const head = [randomUUID(), repo.id, city, branch, path].map(sqlStr).join(', ')
      const sql = `PRAGMA busy_timeout=5000; INSERT INTO workspaces (${cols}) VALUES (${head}, 'ready', 'in-progress', ${sqlStr(repo.defaultBranch)}, ${sqlStr(repo.defaultBranch)}, 'write', datetime('now'), datetime('now'));`
      await exec('sqlite3', [this.dbPath, sql], { timeout: 8_000 })
      return true
    } catch (e) {
      console.error(`[sessions] Conductor register: ${(e as Error).message}`)
      return false
    }
  }
}

/** Deterministic manager for tests: canned sessions + throwaway temp dirs. */
export class FakeSessions implements SessionManager {
  private created: string[] = []

  async listSessions(spec: ProjectSpec): Promise<SessionInfo[]> {
    return [
      { id: 'sess-live', title: 'Build remote Claude Code agent', branch: 'lukasthedude/x', updatedAt: 1783619200000, cwd: spec.repo },
      { id: 'sess-old', title: 'earlier work', updatedAt: 1783610000000, cwd: spec.repo },
    ]
  }
  async getSession(id: string, spec: ProjectSpec): Promise<SessionInfo | undefined> {
    return (await this.listSessions(spec)).find((s) => s.id === id)
  }
  async createWorktree(spec: ProjectSpec, _branch: string): Promise<{ path: string }> {
    const path = mkdtempSync(join(spec.worktreesDir || tmpdir(), 'cc-wt-'))
    this.created.push(path)
    return { path }
  }
  async removeWorktree(cwd: string): Promise<void> {
    rmSync(cwd, { recursive: true, force: true })
  }
}
