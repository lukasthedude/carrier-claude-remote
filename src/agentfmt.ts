// Rendering helpers for Claude Remote agent chats. Pure + DOM-free so it unit-
// tests trivially and the bridge can share the fence logic (see bridge/chunk.ts).
//
// Agent replies are plain-text `msg` frames that may contain ```fenced``` code.
// We split them into text / code segments so the chat can render code in a
// monospace block — WITHOUT any markdown/HTML parsing. Every segment's text is
// still handed to the DOM as textContent (see ui.ts), so nothing here can ever
// inject markup: this only decides where the <pre> boxes go.

export interface MsgSegment {
  code: boolean
  text: string
  /** language tag after the opening fence (```ts → 'ts'), if any. Not rendered
   *  in v1, but kept so a reply split across frames can reopen its fence. */
  lang?: string
}

const OPEN_FENCE = /^```(.*)$/ // a line that starts a fence, capturing the tag
const CLOSE_FENCE = /^```\s*$/ // a bare ``` line closes it

/**
 * Split agent text into ordered text/code segments. Rules:
 *  - a line starting with ``` opens a code block (tag = the rest of the line);
 *  - a bare ``` line closes it; an unclosed fence runs to the end of the text;
 *  - text with no fences returns a single text segment;
 *  - empty text/code segments (the gaps around fences) are dropped.
 */
export function parseFences(text: string): MsgSegment[] {
  const lines = text.split(/\r?\n/)
  const out: MsgSegment[] = []
  let buf: string[] = []
  let inCode = false
  let lang: string | undefined

  const flush = (code: boolean) => {
    const joined = buf.join('\n')
    buf = []
    if (joined.trim() === '') return // a blank gap around a fence — skip it
    out.push({ code, text: joined, ...(code && lang ? { lang } : {}) })
  }

  for (const line of lines) {
    if (!inCode) {
      const m = OPEN_FENCE.exec(line)
      if (m) {
        flush(false)
        inCode = true
        const tag = m[1]!.trim()
        lang = tag.length > 0 && tag.length <= 32 ? tag : undefined
        continue
      }
    } else if (CLOSE_FENCE.test(line)) {
      flush(true)
      inCode = false
      lang = undefined
      continue
    }
    buf.push(line)
  }
  flush(inCode) // trailing text, or an unterminated code block
  return out
}

/** True if the text carries at least one fenced code block worth rendering. */
export function hasCode(text: string): boolean {
  return parseFences(text).some((s) => s.code)
}

// ---------- lightweight markdown for agent replies -------------------------
// Claude writes markdown; a chat bubble full of raw `**` and `##` is noise.
// This parses just the shapes Claude actually uses — headings, bullet/numbered
// lists, paragraphs, fenced code, and inline bold/`code` — into typed blocks
// the UI renders as DOM nodes (textContent only, never innerHTML). Anything
// unrecognized stays a plain paragraph, so nothing is ever lost.

export interface Span {
  text: string
  bold?: boolean
  code?: boolean
}

export type Block =
  | { type: 'p'; spans: Span[] }
  | { type: 'h'; level: 1 | 2 | 3; spans: Span[] }
  | { type: 'list'; ordered: boolean; items: Span[][] }
  | { type: 'code'; text: string; lang?: string }

/** Inline `code` and **bold** runs; code wins over bold, no nesting. */
export function parseInline(text: string): Span[] {
  const out: Span[] = []
  let plain = ''
  let i = 0
  const flush = () => {
    if (plain) {
      out.push({ text: plain })
      plain = ''
    }
  }
  while (i < text.length) {
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1)
      if (end > i + 1) {
        flush()
        out.push({ text: text.slice(i + 1, end), code: true })
        i = end + 1
        continue
      }
    }
    if (text.startsWith('**', i)) {
      const end = text.indexOf('**', i + 2)
      if (end > i + 2) {
        flush()
        out.push({ text: text.slice(i + 2, end), bold: true })
        i = end + 2
        continue
      }
    }
    plain += text[i]
    i++
  }
  flush()
  return out
}

export function parseBlocks(text: string): Block[] {
  const out: Block[] = []
  for (const seg of parseFences(text)) {
    if (seg.code) {
      out.push({ type: 'code', text: seg.text, ...(seg.lang ? { lang: seg.lang } : {}) })
      continue
    }
    let para: string[] = []
    let list: { ordered: boolean; items: string[] } | null = null
    const flushPara = () => {
      if (para.length) {
        out.push({ type: 'p', spans: parseInline(para.join('\n')) })
        para = []
      }
    }
    const flushList = () => {
      if (list) {
        out.push({ type: 'list', ordered: list.ordered, items: list.items.map(parseInline) })
        list = null
      }
    }
    for (const raw of seg.text.split('\n')) {
      const line = raw.trimEnd()
      if (!line.trim()) {
        flushPara()
        flushList()
        continue
      }
      const h = /^(#{1,3})\s+(.*)$/.exec(line)
      if (h) {
        flushPara()
        flushList()
        out.push({ type: 'h', level: h[1]!.length as 1 | 2 | 3, spans: parseInline(h[2]!) })
        continue
      }
      const bullet = /^\s*[-*•]\s+(.*)$/.exec(line)
      const numbered = /^\s*\d{1,3}[.)]\s+(.*)$/.exec(line)
      if (bullet || numbered) {
        flushPara()
        const ordered = !!numbered
        if (list && list.ordered !== ordered) flushList()
        if (!list) list = { ordered, items: [] }
        list.items.push((bullet ?? numbered)![1]!)
        continue
      }
      flushList()
      para.push(line)
    }
    flushPara()
    flushList()
  }
  return out
}

/**
 * A friendly model label for the chat header/picker, the way Anthropic writes
 * them: 'claude-fable-5' → 'Fable 5', 'claude-opus-4-8' → 'Opus 4.8',
 * 'claude-sonnet-4-5-20250929' → 'Sonnet 4.5'. Bare aliases title-case
 * ('opus' → 'Opus'); anything unrecognized falls back to the trimmed id.
 */
export function shortModel(id: string): string {
  let s = id.trim()
  if (!s) return id
  if (s.startsWith('claude-')) s = s.slice('claude-'.length)
  s = s.replace(/-\d{8}$/, '') // drop a trailing -YYYYMMDD snapshot date
  const parts = s.split('-')
  const family = parts[0] ?? ''
  if (!/^[a-zA-Z]+$/.test(family)) return s || id
  const version = parts.slice(1).join('.')
  if (version && !/^\d+(\.\d+)*$/.test(version)) return s || id // e.g. '3-5-sonnet' — leave as-is
  const name = family[0]!.toUpperCase() + family.slice(1)
  return version ? `${name} ${version}` : name
}
