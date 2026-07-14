// Carrier bridge — a headless Carrier peer that turns your Mac into a Claude
// Code agent you talk to from your phone. First run generates an identity and
// prints a chat code to pair; after that it just connects and waits for tasks.
//
//   npm run bridge            # start (edit ~/.carrier-bridge/config.json first)
//   npm run bridge -- --code  # print the chat code and exit
//   npm run bridge -- --reset-owner   # forget the paired phone, re-pair

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { initCrypto } from '../src/crypto'
import { bridgeDir, loadConfig } from './config'
import { Engine } from './engine'
import { CarrierPeer } from './peer'
import type { ClaudeRunner } from './runner'
import { FakeRunner } from './runner-fake'
import { SdkRunner } from './runner-sdk'
import { BridgeState } from './state'

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2))
  await initCrypto()

  const dir = bridgeDir()
  const firstRun = !existsSync(join(dir, 'identity.json'))
  const config = loadConfig(dir)
  const state = new BridgeState(dir)

  if (args.has('--reset-owner')) {
    state.clearOwner()
    console.log('Owner unpaired. Pair again from your phone to re-own this agent.')
  }

  const runnerKind = process.env['CARRIER_BRIDGE_RUNNER'] || config.runner
  const runner: ClaudeRunner = runnerKind === 'fake' ? new FakeRunner() : new SdkRunner()

  const peer = new CarrierPeer(state, config, (code, msg) => {
    console.error(`\n  ✗ The relay turned this agent away (${code}): ${msg}`)
    console.error(`  Set "signupCode" in ${join(dir, 'config.json')} to the relay's access code and start again.\n`)
    process.exit(1)
  })
  const engine = new Engine(peer, runner, config, state)
  peer.handlers = engine

  console.log(`\n  Claude Remote — “${config.name}”`)
  console.log(`  State: ${dir}`)
  console.log(`  Relay: ${config.relay}   Runner: ${runnerKind}`)
  const projects = Object.keys(config.projects)
  console.log(`  Projects: ${projects.length ? projects.join(', ') : '(none set — edit config.json → projects)'}`)

  if (args.has('--code')) {
    await printPairing(peer, config.relay)
    process.exit(0)
  }

  if (firstRun && !config.signupCode) {
    console.log('\n  First run. If thecarrier.org asks for an access code, put it in')
    console.log(`  ${join(dir, 'config.json')} → "signupCode", then start again.`)
  }

  if (!state.ownerPk) {
    await printPairing(peer, config.relay)
    console.log('  Waiting for your phone to pair…\n')
  } else {
    console.log(`  Paired (owner ${state.ownerPk.slice(0, 8)}…). Ready.`)
    console.log('  Re-pair with a different phone:  npm run bridge -- --reset-owner\n')
  }

  peer.start()
  engine.start()

  const shutdown = () => {
    console.log('\n  Shutting down — flushing state…')
    peer.stop()
    state.flush()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

async function printPairing(peer: CarrierPeer, relayUrl: string): Promise<void> {
  const code = peer.chatCode()
  const link = `${webOrigin(relayUrl)}/#i=${code}`
  console.log('\n  ── Pair this agent ─────────────────────────────────────')
  console.log('  In Carrier: turn on Settings → Claude Remote, open the CC')
  console.log('  tab → “Set up an agent”, and paste this chat code:\n')
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
