import { NONCE_BYTES, PK_BYTES, fromB64u, open, seal, toB64u, utf8Decode, utf8Encode } from './crypto'

export class ProtocolError extends Error {}

export const MAX_TEXT = 4000
/** Max SDP/ICE payload carried by an rtc/call-sig frame (a real offer is a few KB). */
export const MAX_SIG = 20_000
export const CHUNK_SIZE = 16 * 1024 // cross-browser-safe SCTP message size
export const MAX_FILE_SIZE = 25 * 1024 * 1024
export const MAX_FILE_CHUNKS = Math.ceil(MAX_FILE_SIZE / CHUNK_SIZE) + 1
/** Small groups only (v1): fan-out cost is O(N) per message. */
export const MAX_GROUP_MEMBERS = 10
/** Most tasks an `a-status` snapshot carries (queued + the running one). */
export const MAX_AGENT_QUEUE = 20
/** Most questions one `a-ask` batches (mirrors the SDK's AskUserQuestion cap). */
export const MAX_AGENT_QUESTIONS = 4
const MAX_FRAME = 65_536
const FID_BYTES = 16
const GID_BYTES = 16 // a group id is 16 random bytes (22 b64u chars) — never collides with a 32-byte pk
const BIN_HEADER = FID_BYTES + 4 + NONCE_BYTES

/** Plaintext content of a frame — everything here is invisible on the wire. */
export type Inner =
  // `gid` is set only on hellos sent in a group context (create/add/mesh/accept)
  // — the receiver uses it to classify the sender as a group-only contact rather
  // than a 1:1 chat. Optional + whitelisted, so old builds simply ignore it.
  | { kind: 'hello'; name: string; pk: string; avatar?: string; caps?: string[]; gid?: string }
  // `replyTo` = the id of the message this one quotes. Optional + whitelisted,
  // so an old build simply drops it and shows a plain message.
  | { kind: 'msg'; id: string; ts: number; text: string; replyTo?: string }
  | { kind: 'ack'; ids: string[] }
  | { kind: 'read'; ids: string[] }
  | { kind: 'typing'; on: boolean }
  | { kind: 'file-meta'; id: string; ts: number; fid: string; name: string; mime: string; size: number; chunks: number }
  | { kind: 'file-done'; fid: string }
  | { kind: 'file-req'; fid: string; need: [number, number][] }
  | { kind: 'file-gone'; fid: string }
  | { kind: 'rtc'; sig: string }
  | { kind: 'bye' }
  // Silent tombstone: the sender deleted their account. Mailboxed so an offline
  // contact still gets it; never pushed (it must not feel like a new message).
  | { kind: 'gone' }
  // --- group chat (client-side fan-out) ---------------------------------------
  // Every group frame is an ordinary pairwise-sealed message that carries the
  // group id, member set, and sender INSIDE the ciphertext, so the relay only
  // ever sees N unrelated 1:1 sends and never learns a group exists. `sender`
  // is trusted only when it equals the crypto_box-authenticated relay `from`.
  | { kind: 'gmsg'; gid: string; sender: string; id: string; ts: number; text: string; replyTo?: string }
  | { kind: 'gfile-meta'; gid: string; sender: string; id: string; ts: number; fid: string; name: string; mime: string; size: number; chunks: number }
  | { kind: 'gack'; gid: string; ids: string[] }
  | { kind: 'gread'; gid: string; ids: string[] }
  | { kind: 'gtyping'; gid: string; on: boolean }
  // Authoritative roster snapshot from the admin; higher epoch wins.
  | { kind: 'ginvite'; gid: string; name: string; members: string[]; epoch: number; admin: string; avatar?: string }
  | { kind: 'gleave'; gid: string }
  | { kind: 'gbye'; gid: string }
  // --- 1:1 calls (WebRTC audio/video) -----------------------------------------
  // Signaling only; DTLS-SRTP media flows phone-to-phone (or via coturn), never
  // through the relay. `call-offer` carries NO SDP — it's a privacy-safe ring
  // (re-sent every 2s for the ring window); real SDP/ICE ride `call-sig` after
  // the callee accepts, so a declined ring discloses zero network info.
  | { kind: 'call-offer'; call: string; mode: 'audio' | 'video' }
  | { kind: 'call-accept'; call: string }
  | { kind: 'call-sig'; call: string; sig: string } // JSON RtcSignal {t:'sdp'|'ice', ...}
  | { kind: 'call-end'; call: string; reason: string } // hangup | decline | busy | cancel (loose)
  | { kind: 'call-log'; call: string; ts: number; mode: 'audio' | 'video'; outcome: string } // e.g. 'missed'
  // --- group calls (audio-only full mesh) -------------------------------------
  // Membership is soft state: a call exists (per observer) while someone beats
  // `gcall-here` for it. `ring:true` beats (starter, for the ring window) fire
  // the existing call push. Media legs are pairwise CallMedia; SDP/ICE ride
  // `gcall-sig`. Same group-blind fanout as gmsg — the relay never sees a gid.
  | { kind: 'gcall-here'; gid: string; call: string; startTs: number; mode: string; ring?: true }
  | { kind: 'gcall-leave'; gid: string; call: string; reason: string } // leave | decline | busy (loose)
  | { kind: 'gcall-sig'; gid: string; call: string; sig: string }
  | { kind: 'gcall-log'; gid: string; call: string; startTs: number; mode: string; outcome: string }
  // --- Claude Remote (a headless "bridge" peer = a Claude Code agent) ----------
  // The bridge advertises caps:['cc'] in its hello; the owner then drops TASKS as
  // ordinary `msg` frames (so custody/receipts/push are unchanged) and the bridge
  // replies with `msg` frames too. These three kinds carry only presence-grade
  // state + a structured question, never task content — and every one is
  // additive, so a build without them just drops the frame (forward-compatible).
  //
  // `a-status` (bridge→owner, volatile like typing): a live snapshot of the
  // agent — current state, model, the model menu, and the task queue.
  | { kind: 'a-status'; ts: number; state: string; model: string; models: string[]; queue: { id: string; title: string; state: string }[] }
  // `a-ctl` (owner→bridge): switch the model, cancel a task (id or 'all'), or ask
  // for a fresh status. `ts` lets the bridge ignore a mailbox-stale cancel.
  | { kind: 'a-ctl'; ts: number; model?: string; cancel?: string; sync?: true }
  // `a-ask` (bridge→owner): a structured question that upgrades the plain
  // numbered-options `msg` (which carries the push) into tappable option chips.
  // `msgId` ties it to that companion message; the owner answers with a `msg`.
  | { kind: 'a-ask'; ask: string; msgId: string; questions: { q: string; header?: string; multi?: boolean; options: { label: string; desc?: string }[] }[] }

/** Most inclusive [start, end] ranges one file-req may carry. */
export const MAX_REQ_RANGES = 256

/** JSON frame: {v:1, n:<b64u nonce>, c:<b64u crypto_box ciphertext>} */
export function encodeFrame(inner: Inner, theirPk: Uint8Array, mySk: Uint8Array): string {
  const { nonce, cipher } = seal(utf8Encode(JSON.stringify(inner)), theirPk, mySk)
  return JSON.stringify({ v: 1, n: toB64u(nonce), c: toB64u(cipher) })
}

/**
 * Returns the decrypted inner message, or null for a valid frame of an
 * unknown kind (forward compatibility: drop, don't crash).
 * Throws ProtocolError/CryptoError on anything malformed or forged.
 */
export function decodeFrame(rawText: string, theirPk: Uint8Array, mySk: Uint8Array): Inner | null {
  if (rawText.length > MAX_FRAME) throw new ProtocolError('frame too large')
  let envelope: unknown
  try {
    envelope = JSON.parse(rawText)
  } catch {
    throw new ProtocolError('frame is not JSON')
  }
  if (typeof envelope !== 'object' || envelope === null) throw new ProtocolError('bad frame shape')
  const e = envelope as Record<string, unknown>
  if (e['v'] !== 1 || typeof e['n'] !== 'string' || typeof e['c'] !== 'string') {
    throw new ProtocolError('bad frame shape')
  }
  const nonce = fromB64u(e['n'])
  if (nonce.length !== NONCE_BYTES) throw new ProtocolError('bad nonce')
  const plain = open(nonce, fromB64u(e['c']), theirPk, mySk)
  let raw: unknown
  try {
    raw = JSON.parse(utf8Decode(plain))
  } catch {
    throw new ProtocolError('inner payload is not JSON')
  }
  return validateInner(raw)
}

function validateInner(raw: unknown): Inner | null {
  if (typeof raw !== 'object' || raw === null) throw new ProtocolError('bad inner shape')
  const o = raw as Record<string, unknown>
  switch (o['kind']) {
    case 'hello': {
      if (typeof o['name'] !== 'string' || o['name'].length > 64) throw new ProtocolError('bad hello')
      if (typeof o['pk'] !== 'string' || fromB64u(o['pk']).length !== 32) throw new ProtocolError('bad hello')
      const avatar =
        typeof o['avatar'] === 'string' && o['avatar'].startsWith('data:image/') && o['avatar'].length <= 60_000
          ? o['avatar']
          : undefined
      // Optional capability advertisement (e.g. ['g'] = supports group chat).
      // Unknown to old builds, which simply ignore it.
      const caps = Array.isArray(o['caps'])
        ? o['caps'].filter((c): c is string => typeof c === 'string' && c.length <= 8).slice(0, 16)
        : undefined
      // An invalid gid drops the field but keeps the hello (like avatar/caps).
      const gid = isGid(o['gid']) ? o['gid'] : undefined
      return { kind: 'hello', name: o['name'], pk: o['pk'], ...(avatar ? { avatar } : {}), ...(caps ? { caps } : {}), ...(gid ? { gid } : {}) }
    }
    case 'msg': {
      if (!isId(o['id']) || !isTs(o['ts'])) throw new ProtocolError('bad msg')
      if (typeof o['text'] !== 'string' || o['text'].length === 0 || o['text'].length > MAX_TEXT) {
        throw new ProtocolError('bad msg text')
      }
      const replyTo = isId(o['replyTo']) ? o['replyTo'] : undefined // whitelist; junk is dropped
      return { kind: 'msg', id: o['id'], ts: o['ts'], text: o['text'], ...(replyTo ? { replyTo } : {}) }
    }
    case 'ack':
    case 'read': {
      const ids = o['ids']
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > 256 || !ids.every(isId)) {
        throw new ProtocolError('bad receipt')
      }
      return { kind: o['kind'], ids: ids as string[] }
    }
    case 'typing': {
      if (typeof o['on'] !== 'boolean') throw new ProtocolError('bad typing')
      return { kind: 'typing', on: o['on'] }
    }
    case 'file-meta': {
      if (!isId(o['id']) || !isTs(o['ts']) || !isFid(o['fid'])) throw new ProtocolError('bad file-meta')
      if (typeof o['name'] !== 'string' || o['name'].length === 0 || o['name'].length > 200) {
        throw new ProtocolError('bad file name')
      }
      if (typeof o['mime'] !== 'string' || o['mime'].length > 100) throw new ProtocolError('bad file mime')
      if (typeof o['size'] !== 'number' || !Number.isInteger(o['size']) || o['size'] < 0 || o['size'] > MAX_FILE_SIZE) {
        throw new ProtocolError('file too large')
      }
      const chunks = o['chunks']
      if (typeof chunks !== 'number' || !Number.isInteger(chunks) || chunks < 1 || chunks > MAX_FILE_CHUNKS) {
        throw new ProtocolError('bad chunk count')
      }
      if (chunks !== chunkCount(o['size'])) throw new ProtocolError('chunk count mismatch')
      return {
        kind: 'file-meta',
        id: o['id'],
        ts: o['ts'],
        fid: o['fid'],
        name: o['name'],
        mime: o['mime'],
        size: o['size'],
        chunks,
      }
    }
    case 'file-done': {
      if (!isFid(o['fid'])) throw new ProtocolError('bad file-done')
      return { kind: 'file-done', fid: o['fid'] }
    }
    case 'file-req': {
      // Receiver-driven repair: "resend me these chunk ranges" (inclusive).
      if (!isFid(o['fid'])) throw new ProtocolError('bad file-req')
      const need = o['need']
      if (!Array.isArray(need) || need.length === 0 || need.length > MAX_REQ_RANGES) {
        throw new ProtocolError('bad file-req ranges')
      }
      const ranges: [number, number][] = []
      for (const r of need) {
        if (!Array.isArray(r) || r.length !== 2) throw new ProtocolError('bad file-req range')
        const [a, b] = r as unknown[]
        if (
          typeof a !== 'number' || typeof b !== 'number' ||
          !Number.isInteger(a) || !Number.isInteger(b) ||
          a < 0 || b < a || b >= MAX_FILE_CHUNKS
        ) {
          throw new ProtocolError('bad file-req range')
        }
        ranges.push([a, b])
      }
      return { kind: 'file-req', fid: o['fid'], need: ranges }
    }
    case 'file-gone': {
      if (!isFid(o['fid'])) throw new ProtocolError('bad file-gone')
      return { kind: 'file-gone', fid: o['fid'] }
    }
    case 'rtc': {
      // WebRTC signaling (SDP / ICE), carried E2E-encrypted so even the relay
      // never sees your network candidates.
      if (typeof o['sig'] !== 'string' || o['sig'].length === 0 || o['sig'].length > MAX_SIG) throw new ProtocolError('bad rtc')
      return { kind: 'rtc', sig: o['sig'] }
    }
    case 'bye':
      return { kind: 'bye' }
    case 'gone':
      return { kind: 'gone' }
    case 'gmsg': {
      if (!isGid(o['gid']) || !isPk(o['sender']) || !isId(o['id']) || !isTs(o['ts'])) throw new ProtocolError('bad gmsg')
      if (typeof o['text'] !== 'string' || o['text'].length === 0 || o['text'].length > MAX_TEXT) {
        throw new ProtocolError('bad gmsg text')
      }
      const greplyTo = isId(o['replyTo']) ? o['replyTo'] : undefined
      return { kind: 'gmsg', gid: o['gid'], sender: o['sender'], id: o['id'], ts: o['ts'], text: o['text'], ...(greplyTo ? { replyTo: greplyTo } : {}) }
    }
    case 'gfile-meta': {
      if (!isGid(o['gid']) || !isPk(o['sender']) || !isId(o['id']) || !isTs(o['ts']) || !isFid(o['fid'])) {
        throw new ProtocolError('bad gfile-meta')
      }
      if (typeof o['name'] !== 'string' || o['name'].length === 0 || o['name'].length > 200) {
        throw new ProtocolError('bad file name')
      }
      if (typeof o['mime'] !== 'string' || o['mime'].length > 100) throw new ProtocolError('bad file mime')
      if (typeof o['size'] !== 'number' || !Number.isInteger(o['size']) || o['size'] < 0 || o['size'] > MAX_FILE_SIZE) {
        throw new ProtocolError('file too large')
      }
      const chunks = o['chunks']
      if (typeof chunks !== 'number' || !Number.isInteger(chunks) || chunks < 1 || chunks > MAX_FILE_CHUNKS) {
        throw new ProtocolError('bad chunk count')
      }
      if (chunks !== chunkCount(o['size'])) throw new ProtocolError('chunk count mismatch')
      return {
        kind: 'gfile-meta',
        gid: o['gid'],
        sender: o['sender'],
        id: o['id'],
        ts: o['ts'],
        fid: o['fid'],
        name: o['name'],
        mime: o['mime'],
        size: o['size'],
        chunks,
      }
    }
    case 'gack':
    case 'gread': {
      if (!isGid(o['gid'])) throw new ProtocolError('bad group receipt')
      const ids = o['ids']
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > 256 || !ids.every(isId)) {
        throw new ProtocolError('bad group receipt')
      }
      return { kind: o['kind'], gid: o['gid'], ids: ids as string[] }
    }
    case 'gtyping': {
      if (!isGid(o['gid']) || typeof o['on'] !== 'boolean') throw new ProtocolError('bad gtyping')
      return { kind: 'gtyping', gid: o['gid'], on: o['on'] }
    }
    case 'ginvite': {
      if (!isGid(o['gid']) || !isPk(o['admin'])) throw new ProtocolError('bad ginvite')
      if (typeof o['name'] !== 'string' || o['name'].length === 0 || o['name'].length > 64) {
        throw new ProtocolError('bad group name')
      }
      const epoch = o['epoch']
      if (typeof epoch !== 'number' || !Number.isInteger(epoch) || epoch < 1) throw new ProtocolError('bad epoch')
      const members = o['members']
      if (!Array.isArray(members) || members.length < 1 || members.length > MAX_GROUP_MEMBERS || !members.every(isPk)) {
        throw new ProtocolError('bad members')
      }
      const gAvatar =
        typeof o['avatar'] === 'string' && o['avatar'].startsWith('data:image/') && o['avatar'].length <= 60_000 ? o['avatar'] : undefined
      return { kind: 'ginvite', gid: o['gid'], name: o['name'], members: members as string[], epoch, admin: o['admin'], ...(gAvatar ? { avatar: gAvatar } : {}) }
    }
    case 'gleave': {
      if (!isGid(o['gid'])) throw new ProtocolError('bad gleave')
      return { kind: 'gleave', gid: o['gid'] }
    }
    case 'gbye': {
      if (!isGid(o['gid'])) throw new ProtocolError('bad gbye')
      return { kind: 'gbye', gid: o['gid'] }
    }
    case 'call-offer': {
      if (!isId(o['call']) || (o['mode'] !== 'audio' && o['mode'] !== 'video')) throw new ProtocolError('bad call-offer')
      return { kind: 'call-offer', call: o['call'], mode: o['mode'] }
    }
    case 'call-accept': {
      if (!isId(o['call'])) throw new ProtocolError('bad call-accept')
      return { kind: 'call-accept', call: o['call'] }
    }
    case 'call-sig': {
      if (!isId(o['call'])) throw new ProtocolError('bad call-sig')
      if (typeof o['sig'] !== 'string' || o['sig'].length === 0 || o['sig'].length > MAX_SIG) throw new ProtocolError('bad call-sig')
      return { kind: 'call-sig', call: o['call'], sig: o['sig'] }
    }
    case 'call-end': {
      // `reason` enum is deliberately loose: an unknown reason still ends the
      // call (no ghost rings from a future client) — the handler maps it to hangup.
      if (!isId(o['call'])) throw new ProtocolError('bad call-end')
      if (typeof o['reason'] !== 'string' || o['reason'].length === 0 || o['reason'].length > 16) throw new ProtocolError('bad call-end')
      return { kind: 'call-end', call: o['call'], reason: o['reason'] }
    }
    case 'call-log': {
      if (!isId(o['call']) || !isTs(o['ts']) || (o['mode'] !== 'audio' && o['mode'] !== 'video')) throw new ProtocolError('bad call-log')
      if (typeof o['outcome'] !== 'string' || o['outcome'].length === 0 || o['outcome'].length > 16) throw new ProtocolError('bad call-log')
      return { kind: 'call-log', call: o['call'], ts: o['ts'], mode: o['mode'], outcome: o['outcome'] }
    }
    // `mode`/`reason`/`outcome` stay loose (like call-end.reason): an unknown
    // value degrades gracefully instead of dropping a beat (= a phantom hangup).
    case 'gcall-here': {
      if (!isGid(o['gid']) || !isId(o['call']) || !isTs(o['startTs']) || !isLoose16(o['mode'])) throw new ProtocolError('bad gcall-here')
      if (o['ring'] !== undefined && o['ring'] !== true) throw new ProtocolError('bad gcall-here')
      return { kind: 'gcall-here', gid: o['gid'], call: o['call'], startTs: o['startTs'], mode: o['mode'], ...(o['ring'] === true ? { ring: true } : {}) }
    }
    case 'gcall-leave': {
      if (!isGid(o['gid']) || !isId(o['call']) || !isLoose16(o['reason'])) throw new ProtocolError('bad gcall-leave')
      return { kind: 'gcall-leave', gid: o['gid'], call: o['call'], reason: o['reason'] }
    }
    case 'gcall-sig': {
      if (!isGid(o['gid']) || !isId(o['call'])) throw new ProtocolError('bad gcall-sig')
      if (typeof o['sig'] !== 'string' || o['sig'].length === 0 || o['sig'].length > MAX_SIG) throw new ProtocolError('bad gcall-sig')
      return { kind: 'gcall-sig', gid: o['gid'], call: o['call'], sig: o['sig'] }
    }
    case 'gcall-log': {
      if (!isGid(o['gid']) || !isId(o['call']) || !isTs(o['startTs']) || !isLoose16(o['mode']) || !isLoose16(o['outcome'])) throw new ProtocolError('bad gcall-log')
      return { kind: 'gcall-log', gid: o['gid'], call: o['call'], startTs: o['startTs'], mode: o['mode'], outcome: o['outcome'] }
    }
    case 'a-status': {
      // A volatile agent snapshot. `state` is a loose enum (idle|busy|waiting
      // today) so a future state degrades gracefully instead of dropping the
      // beat. Malformed → throw; over-long optionals are clamped/trimmed.
      if (!isTs(o['ts']) || !isLoose16(o['state']) || !isModelName(o['model'])) throw new ProtocolError('bad a-status')
      const models = Array.isArray(o['models']) ? o['models'].filter(isModelName).slice(0, 16) : []
      const rawQueue = o['queue']
      if (!Array.isArray(rawQueue) || rawQueue.length > MAX_AGENT_QUEUE) throw new ProtocolError('bad a-status queue')
      const queue = rawQueue.map((e) => {
        const q = e as Record<string, unknown>
        if (!isId(q['id']) || !isLoose16(q['state'])) throw new ProtocolError('bad a-status task')
        if (typeof q['title'] !== 'string' || q['title'].length > 80) throw new ProtocolError('bad a-status title')
        return { id: q['id'], title: q['title'], state: q['state'] }
      })
      return { kind: 'a-status', ts: o['ts'], state: o['state'], model: o['model'], models, queue }
    }
    case 'a-ctl': {
      if (!isTs(o['ts'])) throw new ProtocolError('bad a-ctl')
      const model = isModelName(o['model']) ? o['model'] : undefined
      const cancel = isId(o['cancel']) ? o['cancel'] : undefined // a task id, or 'all'
      const sync = o['sync'] === true ? (true as const) : undefined
      if (!model && !cancel && !sync) throw new ProtocolError('empty a-ctl')
      return { kind: 'a-ctl', ts: o['ts'], ...(model ? { model } : {}), ...(cancel ? { cancel } : {}), ...(sync ? { sync } : {}) }
    }
    case 'a-ask': {
      if (!isId(o['ask']) || !isId(o['msgId'])) throw new ProtocolError('bad a-ask')
      const qs = o['questions']
      if (!Array.isArray(qs) || qs.length < 1 || qs.length > MAX_AGENT_QUESTIONS) throw new ProtocolError('bad a-ask questions')
      const questions = qs.map((raw) => {
        const q = raw as Record<string, unknown>
        if (typeof q['q'] !== 'string' || q['q'].length === 0 || q['q'].length > 500) throw new ProtocolError('bad a-ask q')
        const header = typeof q['header'] === 'string' && q['header'].length > 0 && q['header'].length <= 16 ? q['header'] : undefined
        const opts = q['options']
        if (!Array.isArray(opts) || opts.length < 2 || opts.length > 8) throw new ProtocolError('bad a-ask options')
        const options = opts.map((o2) => {
          const c = o2 as Record<string, unknown>
          if (typeof c['label'] !== 'string' || c['label'].length === 0 || c['label'].length > 120) throw new ProtocolError('bad a-ask option')
          const desc = typeof c['desc'] === 'string' && c['desc'].length > 0 && c['desc'].length <= 250 ? c['desc'] : undefined
          return { label: c['label'], ...(desc ? { desc } : {}) }
        })
        const multi = q['multi'] === true ? (true as const) : undefined
        return { q: q['q'], ...(header ? { header } : {}), ...(multi ? { multi } : {}), options }
      })
      return { kind: 'a-ask', ask: o['ask'], msgId: o['msgId'], questions }
    }
    default:
      return null // unknown kind from a future version: drop silently
  }
}

function isId(x: unknown): x is string {
  return typeof x === 'string' && x.length > 0 && x.length <= 24
}

function isTs(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x > 0
}

/** A loose enum string (mode/reason/outcome): non-empty, ≤16 chars, any value. */
function isLoose16(x: unknown): x is string {
  return typeof x === 'string' && x.length > 0 && x.length <= 16
}

/** A model alias or full id: 'sonnet', 'opus', 'claude-opus-4-8', … (≤48 chars). */
function isModelName(x: unknown): x is string {
  return typeof x === 'string' && x.length > 0 && x.length <= 48
}

function isFid(x: unknown): x is string {
  if (typeof x !== 'string') return false
  try {
    return fromB64u(x).length === FID_BYTES
  } catch {
    return false
  }
}

function isGid(x: unknown): x is string {
  if (typeof x !== 'string') return false
  try {
    return fromB64u(x).length === GID_BYTES
  } catch {
    return false
  }
}

function isPk(x: unknown): x is string {
  if (typeof x !== 'string') return false
  try {
    return fromB64u(x).length === PK_BYTES
  } catch {
    return false
  }
}

// --- binary frames (file chunks): fid(16) ‖ index(u32 BE) ‖ nonce(24) ‖ ciphertext ---

export function encodeChunkFrame(
  fid: Uint8Array,
  index: number,
  chunk: Uint8Array,
  theirPk: Uint8Array,
  mySk: Uint8Array,
): Uint8Array {
  if (fid.length !== FID_BYTES) throw new ProtocolError('bad fid')
  const { nonce, cipher } = seal(chunk, theirPk, mySk)
  const out = new Uint8Array(BIN_HEADER + cipher.length)
  out.set(fid, 0)
  new DataView(out.buffer).setUint32(FID_BYTES, index)
  out.set(nonce, FID_BYTES + 4)
  out.set(cipher, BIN_HEADER)
  return out
}

export function decodeChunkFrame(
  buf: ArrayBuffer,
  theirPk: Uint8Array,
  mySk: Uint8Array,
): { fid: string; index: number; data: Uint8Array } {
  if (buf.byteLength < BIN_HEADER + 16 /* box MAC */ || buf.byteLength > BIN_HEADER + CHUNK_SIZE + 64) {
    throw new ProtocolError('bad chunk frame size')
  }
  const bytes = new Uint8Array(buf)
  const fid = bytes.subarray(0, FID_BYTES)
  const index = new DataView(buf).getUint32(FID_BYTES)
  const nonce = bytes.subarray(FID_BYTES + 4, BIN_HEADER)
  const data = open(nonce, bytes.subarray(BIN_HEADER), theirPk, mySk)
  if (data.length > CHUNK_SIZE || index >= MAX_FILE_CHUNKS) throw new ProtocolError('bad chunk')
  return { fid: toB64u(fid), index, data }
}

// --- chunker / assembler ---

export function chunkCount(size: number): number {
  return Math.max(1, Math.ceil(size / CHUNK_SIZE))
}

export async function* chunkBlob(blob: Blob): AsyncGenerator<{ index: number; data: Uint8Array }> {
  const total = chunkCount(blob.size)
  for (let i = 0; i < total; i++) {
    const slice = blob.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)
    yield { index: i, data: new Uint8Array(await slice.arrayBuffer()) }
  }
}

export interface FileMeta {
  fid: string
  name: string
  mime: string
  size: number
  chunks: number
}

/**
 * Tracks which chunks of an incoming file have arrived. Chunk *data* lives in
 * IndexedDB (so a transfer survives reloads); this only tracks presence, and
 * can be rebuilt at any time from the stored message + persisted chunk keys.
 */
export class ChunkTracker {
  private have = new Set<number>()

  constructor(readonly meta: FileMeta, already?: Iterable<number>) {
    if (meta.size > MAX_FILE_SIZE || meta.chunks > MAX_FILE_CHUNKS || meta.chunks < 1) {
      throw new ProtocolError('file too large')
    }
    if (already) for (const i of already) this.add(i)
  }

  /** Marks a chunk as received. Returns false for an already-seen index. */
  add(index: number): boolean {
    if (!Number.isInteger(index) || index < 0 || index >= this.meta.chunks) {
      throw new ProtocolError('chunk index out of range')
    }
    if (this.have.has(index)) return false
    this.have.add(index)
    return true
  }

  get complete(): boolean {
    return this.have.size === this.meta.chunks
  }

  get progress(): number {
    return this.have.size / this.meta.chunks
  }

  /** Missing chunk indexes as inclusive [start, end] ranges (for a file-req). */
  missing(maxRanges = MAX_REQ_RANGES): [number, number][] {
    const out: [number, number][] = []
    let start = -1
    for (let i = 0; i < this.meta.chunks; i++) {
      if (!this.have.has(i)) {
        if (start < 0) start = i
      } else if (start >= 0) {
        out.push([start, i - 1])
        start = -1
        if (out.length >= maxRanges) return out
      }
    }
    if (start >= 0 && out.length < maxRanges) out.push([start, this.meta.chunks - 1])
    return out
  }
}

/** Expand file-req ranges into sorted, deduplicated, in-bounds chunk indexes. */
export function expandRanges(need: [number, number][], chunks: number): number[] {
  const set = new Set<number>()
  for (const [a, b] of need) {
    for (let i = Math.max(0, a); i <= Math.min(b, chunks - 1); i++) set.add(i)
  }
  return [...set].sort((x, y) => x - y)
}

/** Build the final blob from persisted chunks; throws unless byte-exact. */
export function assembleBlob(meta: FileMeta, parts: Map<number, ArrayBuffer>): Blob {
  const ordered: BlobPart[] = []
  for (let i = 0; i < meta.chunks; i++) {
    const p = parts.get(i)
    if (!p) throw new ProtocolError('file incomplete')
    ordered.push(p)
  }
  const blob = new Blob(ordered, { type: meta.mime || 'application/octet-stream' })
  if (blob.size !== meta.size) throw new ProtocolError('file size mismatch')
  return blob
}
