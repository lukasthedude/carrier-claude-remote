# Carrier bridge

Turn a Mac you leave running into a **Claude Code agent you talk to from
[Carrier](https://thecarrier.org) on your phone**. Text it coding tasks —
"fix this bug", "add that feature" — and it works on your projects and reports
back, asking you to approve anything risky. The Mac does the work; your phone is
the remote. Everything is end-to-end encrypted, exactly like a normal Carrier
chat.

```
  phone (Carrier · CC tab)  ⇄  blind relay  ⇄  this bridge (your Mac)  ⇄  Claude Code  ⇄  Anthropic
```

The bridge is a full Carrier peer: it has its own identity and pairs with your
phone by pasting a code, just like adding a friend.

## What leaves your Mac (read this)

- **To the relay:** only end-to-end-encrypted frames. The relay sees two public
  keys, size, and timing — never content. A task, a reply, and an approval all
  look identical to any other message.
- **To Anthropic:** your task text and whatever files Claude reads in the
  project go to the Anthropic API under this Mac's own `claude` login — the same
  exposure as running `claude` in that repo yourself. Nothing more.
- **On disk** (`~/.carrier-bridge`, created `0700`; `identity.json` is `0600`):
  the agent's private key (it *is* the account), the paired phone's public key,
  the task queue text, and your config. No chat history is stored.

## What you need

- A Mac (or any always-on box) with **Node ≥ 20**.
- **Claude Code** installed and logged in — a Claude Pro/Max plan or API credits.
- The relay's **access code** — ask whoever invited you (Carrier is invite-only).
- Your phone with **Carrier on version 1.35 or newer** (it auto-updates; check
  Settings). Turn on **Settings → Claude Remote**.

## Setup

```bash
# 1) Install Node from nodejs.org (the .pkg installer), then in Terminal:
npm install -g @anthropic-ai/claude-code   # (sudo if it says permission denied)
claude                                       # sign in once, then /exit

# 2) Get this bridge and its dependencies
git clone https://github.com/lukasthedude/carrier-bridge.git   # or download the ZIP
cd carrier-bridge
npm install

# 3) First run writes a config, then stops for you to edit it
npm run bridge
```

Open `~/.carrier-bridge/config.json` (`open ~/.carrier-bridge/config.json`) and
set at least:

- `signupCode` — the relay access code you were given
- `name` — how the agent shows up on your phone
- `projects` — the folder(s) it may work on, e.g. `{ "site": "/Users/me/dev/site" }`
- `defaultProject` — which one a bare task uses

Then run `npm run bridge` again. It prints a **chat code and a QR**.

## Pair your phone

1. In Carrier: **Settings → Claude Remote** (on) → the **CC** tab → **Set up an
   agent** → **paste the code** (or scan the QR).
2. Compare the **safety number** the Terminal prints with the one on your phone
   (open the agent chat → ⋯ → **Verify safety number**). They must match.

The first phone to pair becomes the **owner** and is pinned forever; every other
sender is ignored. Re-pair with a different phone: `npm run bridge -- --reset-owner`.

## Using it

Anything you send that doesn't start with `/` is a task; send several and they
queue. Commands:

| Command | Does |
|---|---|
| `/status` | model, queue, what it's doing |
| `/model [name]` | list or switch model (also from the model chip in the app) |
| `/cancel [id\|all]` | stop the running task, or all (also the Stop button) |
| `/new` | fresh session — forget earlier context |
| `/project [name]` | list or switch project |
| `/queue <task>` | queue a task while it's waiting on your answer |
| `/help` | this list |

When Claude needs a decision it asks in the chat as tappable options.

## Permissions (ask-on-risky)

`permissionMode` in the config controls autonomy:

- `default` *(recommended)* — auto-runs safe, project-local work (reads, edits
  in the project, `git status`, `npm test`); **asks your phone to approve**
  anything risky: `git push`, installs, deletes, network, `sudo`, or files
  outside the project.
- `acceptEdits` — as above, but file edits never ask.
- `bypassPermissions` — never asks (only on a machine you're fine handing over).

Your own `~/.claude` allow/deny rules still apply on top (deny always wins).

## Keep it running forever

- **Stop sleeping:** System Settings → Displays → prevent sleeping while plugged in.
- **Auto-start + restart:** edit the paths in `bridge/com.carrier.bridge.plist`,
  then `cp` it to `~/Library/LaunchAgents/` and
  `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.carrier.bridge.plist`.
  Logs: `~/.carrier-bridge/bridge.log`.

## Troubleshooting

- **"turned this agent away (signup)"** — put the relay access code in
  `~/.carrier-bridge/config.json` → `signupCode`, then restart.
- **"Claude Agent SDK not installed"** — `npm install` in this folder again.
- **Re-pair / wrong phone** — `npm run bridge -- --reset-owner`, then pair again.
- **See what it's doing** — `tail -f ~/.carrier-bridge/bridge.log`.

## Config reference

See `config.example.json`. Everything defaults sensibly except `projects`,
`signupCode`, and `name`.
