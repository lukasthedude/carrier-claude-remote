// Split an agent reply into ≤MAX_TEXT pieces for the wire, without leaving a
// ```code fence``` open across a chunk boundary: a fence open at the end of one
// chunk is closed there and reopened (with its language) at the start of the
// next, so each chunk renders correctly on its own. Pure + unit-tested.

import { MAX_TEXT } from '../src/protocol'

const FENCE = '```'
const OPEN = /^```(.*)$/
const CLOSE = /^```\s*$/

export function chunkText(text: string, max = MAX_TEXT): string[] {
  if (text.length <= max) return [text]
  const lines = text.split('\n')
  const chunks: string[] = []
  let cur: string[] = []
  let curLen = 0
  let fenceLang: string | null = null // non-null ⇒ inside a fence ('' = no lang)

  const flush = () => {
    if (cur.length === 0) return
    let body = cur.join('\n')
    if (fenceLang !== null) body += '\n' + FENCE // close an open fence at the seam
    chunks.push(body)
    cur = []
    curLen = 0
    if (fenceLang !== null) {
      const reopen = FENCE + fenceLang // reopen in the next chunk
      cur.push(reopen)
      curLen = reopen.length + 1
    }
  }

  for (const raw of lines) {
    // A line that can't fit in a chunk on its own — hard-split it. Inside a
    // fence that budget shrinks by the reopen (```lang) + close (```) overhead,
    // so a near-max line inside a fence still overflows unless we count it here.
    // Splitting de-fences the giant line (its slices render as plain, standalone
    // chunks), keeping every chunk ≤max and fences balanced.
    const fenceOverhead = fenceLang !== null ? FENCE.length + fenceLang.length + 1 + (FENCE.length + 1) : 0
    if (raw.length + 1 + fenceOverhead > max) {
      const lang: string | null = fenceLang
      flush() // closes an open fence and queues its reopen…
      cur = [] // …which we drop; the reopen belongs AFTER the giant line
      curLen = 0
      fenceLang = null
      for (let s = raw; s.length > 0; s = s.slice(max)) chunks.push(s.slice(0, max))
      if (lang !== null) {
        const reopen = FENCE + lang
        cur.push(reopen)
        curLen = reopen.length + 1
        fenceLang = lang
      }
      continue
    }
    const opening: RegExpExecArray | null = fenceLang === null ? OPEN.exec(raw) : null
    const closing: boolean = fenceLang !== null && CLOSE.test(raw)
    // Reserve room to close the fence if this chunk is already fenced OR this
    // line opens one — otherwise appending an opening ``` to a nearly-full chunk
    // and closing it at flush would overflow.
    const reserve = fenceLang !== null || opening ? FENCE.length + 1 : 0
    if (curLen + raw.length + 1 + reserve > max && cur.length > 0) flush()
    cur.push(raw)
    curLen += raw.length + 1
    if (opening) fenceLang = (opening[1] ?? '').trim()
    else if (closing) fenceLang = null
  }
  flush()
  return chunks.filter((c) => c.length > 0)
}
