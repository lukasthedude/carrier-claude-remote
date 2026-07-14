// Carrier · Claude Remote — a headless HOST on your Mac. Pair it once from the
// phone, then spawn many agents (each its own chat, its own worktree/session).
//
//   npm start                  # run the host (edit ~/.carrier-bridge/config.json first)
//   npm start -- --code        # print the pairing code and exit
//   npm start -- --reset-owner # forget the paired phone + fleet, re-pair

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { initCrypto } from '../src/crypto'
import { bridgeDir, loadConfig } from './config'
import { HostController } from './host'
import type { ClaudeRunner } from './runner'
import { FakeRunner } from './runner-fake'
import { SdkRunner } from './runner-sdk'
import { FakeSessions, SdkSessions, type SessionManager } from './sessions'
import { HostState } from './state'

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2))
  await initCrypto()

  const dir = bridgeDir()
  const firstRun = !existsSync(join(dir, 'identity.json'))
  const config = loadConfig(dir)
  const state = new HostState(dir)

  if (args.has('--reset-owner')) {
    state.clearOwner()
    console.log('Owner unpaired (and the fleet cleared). Pair again from your phone to re-own this host.')
  }

  const runnerKind = process.env['CARRIER_BRIDGE_RUNNER'] || config.runner
  const runner: ClaudeRunner = runnerKind === 'fake' ? new FakeRunner() : new SdkRunner()
  const sessions: SessionManager = runnerKind === 'fake' ? new FakeSessions() : new SdkSessions()

  const host = new HostController(state, config, runner, sessions, (code, msg) => {
    console.error(`\n  ✗ The relay turned this host away (${code}): ${msg}`)
    console.error(`  Set "signupCode" in ${join(dir, 'config.json')} to the relay's access code and start again.\n`)
    process.exit(1)
  })

  console.log(`\n  Carrier · Claude Remote — host “${config.name}”`)
  console.log(`  State: ${dir}`)
  console.log(`  Relay: ${config.relay}   Runner: ${runnerKind}`)
  const projects = Object.keys(config.projects)
  console.log(`  Projects: ${projects.length ? projects.join(', ') : '(none set — edit config.json → projects)'}`)

  if (args.has('--code')) {
    await printPairing(host.chatCode(), config.relay)
    process.exit(0)
  }

  if (firstRun && !config.signupCode) {
    console.log('\n  First run. If thecarrier.org asks for an access code, put it in')
    console.log(`  ${join(dir, 'config.json')} → "signupCode", then start again.`)
  }

  if (!state.ownerPk) {
    await printPairing(host.chatCode(), config.relay)
    console.log('  Waiting for your phone to pair…\n')
  } else {
    console.log(`  Paired (owner ${state.ownerPk.slice(0, 8)}…) · ${state.agents.length} agent(s). Ready.`)
    console.log('  Re-pair with a different phone:  npm start -- --reset-owner\n')
  }

  host.start()

  const shutdown = () => {
    console.log('\n  Shutting down — flushing state…')
    host.stop()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

async function printPairing(code: string, relayUrl: string): Promise<void> {
  const link = `${webOrigin(relayUrl)}/#i=${code}`
  console.log('\n  ── Pair this Mac ───────────────────────────────────────')
  console.log('  In Carrier: Settings → Claude Remote (on), open the CC tab →')
  console.log('  “Connect a Mac”, and paste this code (or scan the QR):\n')
  console.log(`  ${code}\n`)
  console.log(`  or open on your phone:  ${link}`)
  await printQr(link)
  console.log('  ────────────────────────────────────────────────────────')
}

/** Best-effort terminal QR of the invite link (optional dependency). Called
 *  bound to the module (`qr.generate`) — the lib reads `this` for its config. */
async function printQr(text: string): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = (await import('qrcode-terminal')) as any
    const qr = mod.default ?? mod
    qr.generate(text, { small: true }, (out: string) => console.log('\n' + out))
  } catch {
    /* qrcode-terminal absent or failed — the link above is enough */
  }
}

/** wss://host/ws → https://host (where the PWA lives). */
function webOrigin(relayUrl: string): string {
  try {
    const u = new URL(relayUrl)
    const proto = u.protocol === 'wss:' ? 'https:' : 'http:'
    return `${proto}//${u.host}`
  } catch {
    return 'https://thecarrier.org'
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
