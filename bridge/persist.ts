// Typed port of the relay's JsonStore (server/persist.mjs): load at boot,
// debounced atomic writes while running, synchronous flush on shutdown. The
// root tsconfig has no allowJs, so the bridge reimplements it rather than import
// the .mjs. Files are written 0600 — they hold the identity key and task text.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const WRITE_DEBOUNCE_MS = 1000

export class JsonStore<T> {
  private path: string
  private tmp: string
  private timer: ReturnType<typeof setTimeout> | null = null
  private getData: (() => T) | null = null

  constructor(dir: string, name: string) {
    this.path = join(dir, name)
    this.tmp = `${this.path}.tmp`
    mkdirSync(dir, { recursive: true })
  }

  load(fallback: T): T {
    try {
      if (!existsSync(this.path)) return fallback
      return JSON.parse(readFileSync(this.path, 'utf8')) as T
    } catch (e) {
      console.error(`[persist] failed to load ${this.path}: ${(e as Error).message}`)
      return fallback
    }
  }

  /** Register the snapshot function; markDirty() serializes it on a debounce. */
  bind(getData: () => T): void {
    this.getData = getData
  }

  markDirty(): void {
    if (this.timer || !this.getData) return
    this.timer = setTimeout(() => { this.timer = null; this.write() }, WRITE_DEBOUNCE_MS)
  }

  write(): void {
    if (!this.getData) return
    try {
      writeFileSync(this.tmp, JSON.stringify(this.getData()), { mode: 0o600 })
      renameSync(this.tmp, this.path) // atomic swap — never a half-written file
    } catch (e) {
      console.error(`[persist] failed to write ${this.path}: ${(e as Error).message}`)
    }
  }

  flushSync(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this.write()
  }
}
