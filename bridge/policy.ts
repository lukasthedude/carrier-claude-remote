// Ask-on-risky permission policy: decide which tool calls Claude can run
// unattended vs. which ping the owner for approval in the chat. This IS the
// security boundary, so it is aggressively fail-closed — auto-approve ONLY a
// single, simple invocation of a known read-ish verb, with no shell
// metacharacters and no path that escapes the project. Everything else asks.
// Pure + unit-tested. The owner's own ~/.claude allow/deny rules apply on top
// (a deny always wins). A heuristic can't be airtight — the ask-back is the
// real safety net, so over-asking is the intended failure mode.

import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'

export type ToolVerdict = 'auto' | 'ask'

// File/read tools are auto within the project; a path (absolute OR relative)
// that escapes the project asks.
const FILE_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
// Non-filesystem safe tools.
const AUTO_TOOLS = new Set(['TodoWrite'])

// Verbs that only read or make project-local, side-effect-light changes. NOTE:
// deliberately excludes interpreters (node/python/awk/sed/perl/ruby/osascript…)
// and anything that can spawn code or symlink — those always ask.
const SAFE_BASH = new Set([
  'ls', 'cat', 'head', 'tail', 'grep', 'rg', 'find', 'pwd', 'echo', 'wc', 'sort', 'uniq',
  'diff', 'stat', 'file', 'tree', 'which', 'date', 'git', 'test', 'true', 'printf', 'jq',
  'basename', 'dirname', 'cut', 'tr',
  // package managers: the dangerous subcommands (install/ci/exec/publish/…) are
  // caught by RISKY below, so `npm test` / `npm run build` stay auto but
  // `npm install` asks. Their run-scripts are the project's own code (the same
  // trust boundary as editing the repo).
  'npm', 'pnpm', 'yarn',
])

// Shell metacharacters we won't reason about: chaining, redirection, command
// substitution, variable expansion, subshells, brace expansion, newlines. Any
// of these → ask (so `a && b`, `a | b`, `a > f`, `$(x)`, `` `x` ``, `$VAR` all ask).
const SHELL_META = /[;&|<>`$(){}\n]/

// Even a single safe-looking verb asks if it matches one of these.
const RISKY: RegExp[] = [
  /\bgit\s+(push|clone|pull|fetch|remote|config|clean)\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\b(npm|pnpm|yarn|bun)\s+(i\b|install|add|remove|rm|uninstall|ci\b|exec|dlx|publish|update|up|create|link)/,
  /\b(npx|bunx|pnpx)\b/,
  /\bfind\b.*\s-(delete|exec(dir)?)\b/,
  /\brm\b/,
  /\brmdir\b/,
  /\bsudo\b/,
  /\bkill(all)?\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bln\b/,
  /\b(curl|wget|ssh|scp|rsync|nc|telnet)\b/,
  /\b(brew|apt|apt-get|port|pip|pip3|gem|cargo)\b/,
  /\bdocker\b/,
  /\bmv\b/,
  /\bcp\b/,
  /\bdd\b/,
]

export function classifyTool(toolName: string, input: Record<string, unknown>, projectDir: string): ToolVerdict {
  if (toolName === 'Bash') return classifyBash(typeof input['command'] === 'string' ? (input['command'] as string) : '', projectDir)
  if (FILE_TOOLS.has(toolName)) {
    const fp = input['file_path'] ?? input['path'] ?? input['notebook_path']
    if (typeof fp === 'string' && !within(projectDir, absFrom(projectDir, fp))) return 'ask'
    return 'auto'
  }
  if (AUTO_TOOLS.has(toolName)) return 'auto'
  return 'ask' // WebFetch/WebSearch/MCP/unknown → ask
}

/** Auto only if: non-empty, no shell metacharacters, verb is safe, not risky,
 *  and (when a project dir is given) no argument escapes the project. */
export function classifyBash(command: string, projectDir?: string): ToolVerdict {
  const cmd = command.trim()
  if (!cmd) return 'ask'
  if (SHELL_META.test(cmd)) return 'ask' // can't reason about compound/redirected/expanded commands
  if (RISKY.some((re) => re.test(cmd))) return 'ask'
  const first = (cmd.split(/\s+/)[0] ?? '').split('/').pop() ?? ''
  if (!SAFE_BASH.has(first)) return 'ask'
  if (projectDir && bashEscapesProject(cmd, projectDir)) return 'ask'
  return 'auto'
}

/** True if any path-like argument (absolute, ~, or ..-traversing) resolves
 *  outside the project — so `cat ~/.ssh/id_rsa` or `cat ../secrets` asks. */
function bashEscapesProject(cmd: string, projectDir: string): boolean {
  for (const raw of cmd.split(/\s+/).slice(1)) {
    const t = raw.replace(/^['"]|['"]$/g, '')
    if (!t || t.startsWith('-')) continue
    if (t.startsWith('/') || t.startsWith('~') || t.startsWith('..') || t.includes('/../')) {
      if (!within(projectDir, absFrom(projectDir, t))) return true
    }
  }
  return false
}

function absFrom(projectDir: string, p: string): string {
  if (p.startsWith('~')) return resolve(homedir(), p.slice(1).replace(/^\//, ''))
  return isAbsolute(p) ? p : resolve(projectDir, p)
}

function within(dir: string, file: string): boolean {
  const d = resolve(dir)
  const f = resolve(file)
  return f === d || f.startsWith(d + '/')
}
