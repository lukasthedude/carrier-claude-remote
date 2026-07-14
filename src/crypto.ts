import sodium from 'libsodium-wrappers'

export class CryptoError extends Error {}

export const NONCE_BYTES = 24 // crypto_box_NONCEBYTES
export const PK_BYTES = 32 // crypto_box_PUBLICKEYBYTES

// Domain-separation strings. Frozen forever: changing one changes every user's
// displayed digits for that primitive.
const SAFETY_DOMAIN = 'p2pchat.safety.v1'
const GROUP_DOMAIN = 'p2pchat.group.v1'

export async function initCrypto(): Promise<void> {
  await sodium.ready
  if (sodium.crypto_box_NONCEBYTES !== NONCE_BYTES || sodium.crypto_box_PUBLICKEYBYTES !== PK_BYTES) {
    throw new CryptoError('libsodium constant mismatch')
  }
}

export interface Identity {
  publicKey: Uint8Array
  privateKey: Uint8Array
}

export function generateIdentity(): Identity {
  const kp = sodium.crypto_box_keypair()
  return { publicKey: kp.publicKey, privateKey: kp.privateKey }
}

/** Recover the full identity from just its 32-byte private key (the public
 *  key is deterministically the X25519 base-point multiple of it). Lets a
 *  recovery phrase carry only the secret. */
export function identityFromPrivateKey(privateKey: Uint8Array): Identity {
  if (privateKey.length !== PK_BYTES) throw new CryptoError('bad private key length')
  return { publicKey: sodium.crypto_scalarmult_base(privateKey), privateKey }
}

// --- passphrase-based symmetric encryption (account export, device lock) ---
//
// Uses the platform's Web Crypto: PBKDF2-HMAC-SHA256 to stretch the passphrase
// (600k iterations — the OWASP 2023 floor), then AES-256-GCM for the payload.
// Native, hardware-accelerated, zero bundle cost, and available in both the
// browser (secure context) and Node ≥20 — no extra libsodium build needed.
// (Argon2id would be more brute-force-resistant; a future hardening if we ever
// bundle the libsodium "sumo" build.)

export const KDF_ITERATIONS = 600_000
const KDF_SALT_BYTES = 16
const AES_IV_BYTES = 12

export interface KdfParams {
  salt: Uint8Array
  iterations: number
}

export function defaultKdfParams(): KdfParams {
  return { salt: randomBytes(KDF_SALT_BYTES), iterations: KDF_ITERATIONS }
}

/** Stretch a passphrase into an AES-256-GCM key (non-extractable). */
export async function deriveKey(passphrase: string, p: KdfParams): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', toArrayBuffer(utf8Encode(passphrase)), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: toArrayBuffer(p.salt), iterations: p.iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** Authenticated symmetric encryption under a derived key. `nonce` is the IV. */
export async function aesEncrypt(plain: Uint8Array, key: CryptoKey): Promise<Sealed> {
  const nonce = randomBytes(AES_IV_BYTES)
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toArrayBuffer(nonce) }, key, toArrayBuffer(plain))
  return { nonce, cipher: new Uint8Array(cipher) }
}

/** Throws CryptoError on a wrong key or tampering. */
export async function aesDecrypt(nonce: Uint8Array, cipher: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: toArrayBuffer(nonce) }, key, toArrayBuffer(cipher))
    return new Uint8Array(plain)
  } catch {
    throw new CryptoError('wrong passphrase or corrupt data')
  }
}

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer
}

export function toB64u(bytes: Uint8Array): string {
  return sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING)
}

export function fromB64u(s: string): Uint8Array {
  try {
    return sodium.from_base64(s, sodium.base64_variants.URLSAFE_NO_PADDING)
  } catch {
    throw new CryptoError('invalid base64url')
  }
}

export function utf8Encode(s: string): Uint8Array {
  return sodium.from_string(s)
}

export function utf8Decode(b: Uint8Array): string {
  return sodium.to_string(b)
}

export function randomBytes(n: number): Uint8Array {
  return sodium.randombytes_buf(n)
}

export interface Sealed {
  nonce: Uint8Array
  cipher: Uint8Array
}

/** Authenticated encryption to `theirPk`, provably from the holder of `mySk`. */
export function seal(plain: Uint8Array, theirPk: Uint8Array, mySk: Uint8Array): Sealed {
  const nonce = sodium.randombytes_buf(NONCE_BYTES)
  const cipher = sodium.crypto_box_easy(plain, nonce, theirPk, mySk)
  return { nonce, cipher }
}

/** Throws CryptoError on forgery, tampering, or wrong keys. */
export function open(nonce: Uint8Array, cipher: Uint8Array, theirPk: Uint8Array, mySk: Uint8Array): Uint8Array {
  try {
    return sodium.crypto_box_open_easy(cipher, nonce, theirPk, mySk)
  } catch {
    throw new CryptoError('decryption failed: wrong key or tampered data')
  }
}

/** Open an anonymous sealed box addressed to our key (used for relay auth). */
export function sealOpen(sealed: Uint8Array, myPk: Uint8Array, mySk: Uint8Array): Uint8Array {
  try {
    return sodium.crypto_box_seal_open(sealed, myPk, mySk)
  } catch {
    throw new CryptoError('seal open failed')
  }
}

export function blake2b(outLen: number, ...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const buf = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    buf.set(p, off)
    off += p.length
  }
  return sodium.crypto_generichash(outLen, buf, null)
}

/**
 * 40 decimal digits (~133 bits) committing to both identity keys.
 * Identical on both devices; compared out-of-band to rule out a
 * man-in-the-middle on the pairing channel.
 */
export function safetyNumber(pkA: Uint8Array, pkB: Uint8Array): string {
  if (pkA.length !== PK_BYTES || pkB.length !== PK_BYTES) throw new CryptoError('bad public key length')
  const [lo, hi] = compareBytes(pkA, pkB) <= 0 ? [pkA, pkB] : [pkB, pkA]
  return digitsFrom(blake2b(40, utf8Encode(SAFETY_DOMAIN), lo, hi))
}

/**
 * 40 decimal digits committing to a group's exact member set. Order-independent
 * (the pks are sorted first), so it is identical on every member's device iff
 * their rosters match — compared out-of-band to confirm the same membership.
 * Attests *who is in the group*, not the security of each link (that stays with
 * the pairwise safety numbers).
 */
export function groupFingerprint(memberPks: Uint8Array[]): string {
  if (memberPks.some((pk) => pk.length !== PK_BYTES)) throw new CryptoError('bad public key length')
  const sorted = [...memberPks].sort(compareBytes)
  return digitsFrom(blake2b(40, utf8Encode(GROUP_DOMAIN), ...sorted))
}

/**
 * Per-recipient file id for a group send: a group file streams to each member
 * under a DISTINCT id derived from the local file id + that member's pk, so the
 * relay sees N unrelated file ids instead of one shared tag linking the group.
 * Deterministic, so the sender recomputes it for repair without storing a map;
 * unguessable to the relay (it can't invert the hash to see the shared source).
 */
export function deriveWireFid(localFid: Uint8Array, memberPk: Uint8Array): Uint8Array {
  return blake2b(16, utf8Encode('p2pchat.gfid.v1'), localFid, memberPk)
}

/** 40-byte digest → 40 decimal digits (8 groups of 5), the shared display form. */
function digitsFrom(h: Uint8Array): string {
  let digits = ''
  for (let i = 0; i < 8; i++) {
    const c = h.subarray(i * 5, i * 5 + 5)
    // 5 bytes → 40-bit big-endian integer (safe inside Number)
    const v = c[0]! * 4294967296 + c[1]! * 16777216 + c[2]! * 65536 + c[3]! * 256 + c[4]!
    digits += String(v % 100000).padStart(5, '0')
  }
  return digits
}

/** "1234567890…" → ["12345 67890 …", "… …"] — two display rows of four groups. */
export function formatSafetyNumber(digits: string): [string, string] {
  const groups = digits.match(/.{5}/g) ?? []
  return [groups.slice(0, 4).join(' '), groups.slice(4, 8).join(' ')]
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!
    if (d !== 0) return d
  }
  return 0
}
