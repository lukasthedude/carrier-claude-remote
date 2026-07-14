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

/**
 * A compact model label for the chat header/picker: 'claude-sonnet-4-5' →
 * 'sonnet-4-5', dropping the 'claude-' prefix and any trailing release date.
 * Aliases ('sonnet', 'opus', 'haiku') pass through unchanged.
 */
export function shortModel(id: string): string {
  let s = id.trim()
  if (s.startsWith('claude-')) s = s.slice('claude-'.length)
  s = s.replace(/-\d{8}$/, '') // drop a trailing -YYYYMMDD snapshot date
  return s || id
}
