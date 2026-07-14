# Keeping this repo in sync with Carrier

`src/crypto.ts`, `src/protocol.ts`, and `src/agentfmt.ts` are **copied verbatim**
from the main (private) Carrier repo — they're the crypto + wire-protocol the
bridge shares with the app. They change rarely: the wire format is additive and
frozen (unknown frame kinds are dropped), so an out-of-date copy still
interoperates. Update them only when the protocol gains something the bridge
needs.

To refresh from a local Carrier checkout:

```bash
CARRIER=/path/to/carrier          # your private Carrier clone
cp "$CARRIER"/src/crypto.ts    src/crypto.ts
cp "$CARRIER"/src/protocol.ts  src/protocol.ts
cp "$CARRIER"/src/agentfmt.ts  src/agentfmt.ts

# and the bridge itself, if it changed:
cp "$CARRIER"/bridge/*.ts bridge/
cp "$CARRIER"/bridge/com.carrier.bridge.plist bridge/

npm run typecheck   # confirm it still builds
```

Nothing else from the app is needed here — the bridge only imports those three
modules (verified: `grep -rE "from '\.\./src/" bridge`).
