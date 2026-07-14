// Session + worktree manager: lists resumable Claude Code sessions (so the phone
// can "continue this exact conversation") and creates/removes git worktrees (so
// each new agent is isolated, Conductor-style). Real impl drives the SDK + git;
// FakeSessions backs the tests (no Claude login, no real git).

import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { randomBytes, toB64u } from '../src/crypto'
import type { ProjectSpec } from './config'

const exec = promisify(execFile)

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
