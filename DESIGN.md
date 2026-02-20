# OpenClaw Nostr NIP-29 Plugin — Clean Rewrite

## Goal
Minimal OpenClaw channel plugin for NIP-29 group chats on authenticated relays.
Replaces the bundled nostr plugin (which is NIP-17 DM focused + our messy patches).

## Plugin SDK Contract
- Implement `ChannelPlugin` interface from `openclaw/plugin-sdk`
- Register via `api.registerChannel({ plugin })` in plugin entry
- Key adapters needed: `config`, `security`, `outbound`
- Inbound via `runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher()`
- Plugin manifest: `openclaw.plugin.json` with `"channels": ["nostr"]`

## Architecture
- **External plugin** loaded from `~/.openclaw/extensions/nostr-nip29/`
- Single relay connection (zooid) with NIP-42 AUTH
- NIP-29 group subscription (kind 9, 11, 12)
- ~200 lines of relay code, ~200 lines of plugin glue

## Inbound Flow
1. Connect to relay → AUTH with bot's nsec
2. Subscribe to configured groups (kind 9/11/12, #h filter)  
3. On event → skip own pubkey → mention gate → `dispatchReplyWithBufferedBlockDispatcher()`
4. Agent receives message, processes, replies

## Outbound Flow
1. Agent reply → `outbound.sendText()` or reply callback
2. Build kind 9 event with `["h", groupId]` tag
3. Sign with bot's nsec → publish to relay

## Mention Detection (proven working — test-mention.ts)
1. Check p-tags for bot pubkey (most clients add this) ✅
2. Check text for hex pubkey ✅
3. Decode `nostr:nprofile1...` / `nostr:npub1...` URIs → compare hex ✅
4. Check text for bot name (fallback) ✅

## AUTH Handling (proven working — test-auth-v3.ts)
- Patch `relay.auth` immediately after connect to inject signer
- If challenge present on connect, auth immediately
- Set `relay.onauth` for future challenges
- Wait for auth to settle before subscribing

## Config Schema
```json
{
  "nostr": {
    "enabled": true,
    "privateKey": "nsec1...",
    "name": "clarity",
    "relay": "wss://zooid.atlantislabs.space",
    "groups": [
      { "id": "techteam", "mentionOnly": true },
      { "id": "inner-circle", "mentionOnly": true }
    ],
    "groupAllowFrom": ["*"],
    "groupRequireMention": true
  }
}
```

## Dev Process (agent-testable, no human in loop)

### Phase 1: Standalone Relay Tests (`bun test`)
- `test/relay.test.ts` — connect, auth, subscribe, receive events
- `test/mentions.test.ts` — all mention detection cases (p-tag, nprofile, npub, name)
- `test/roundtrip.test.ts` — send message → receive → detect mention → publish reply
- All tests use real zooid relay (not mocks — we test the actual thing)
- Bot sends test messages to itself via a second keypair

### Phase 2: Plugin Shell
- Minimal `ChannelPlugin` implementation with stubs
- Test: loads into OpenClaw without errors (check logs)

### Phase 3: Wire Relay → Plugin
- Connect proven relay code into plugin
- Inbound + outbound wired

### Phase 4: Integration
- Enable plugin, send Nostr mention, verify agent response

## File Structure
```
openclaw-nostr-plugin/
├── openclaw.plugin.json     # Plugin manifest
├── index.ts                 # Plugin entry
├── package.json
├── src/
│   ├── plugin.ts            # ChannelPlugin implementation
│   ├── relay.ts             # Relay connection + AUTH
│   ├── mentions.ts          # Mention detection
│   ├── config.ts            # Config schema + resolver
│   └── types.ts             # Shared types
├── test/
│   ├── relay.test.ts        # Connection + AUTH + subscription
│   ├── mentions.test.ts     # Mention detection unit tests
│   └── roundtrip.test.ts    # Full send → receive → reply cycle
└── DESIGN.md
```

## Key Decisions
- Single relay (not pool) — zooid is our only NIP-29 relay
- No NIP-17 DMs initially (add later if needed)
- No profiles/metrics/state-store bloat
- TypeScript + nostr-tools (Relay class)
- Real relay tests > mocks (we're testing integration, not logic)
- Plugin ID: `nostr` (replaces bundled, which stays disabled)

## Proven Test Results (2026-02-20)
- AUTH: ✅ relay.auth patch + onauth handler
- Subscription: ✅ receives NIP-29 events after auth
- Mention detection: ✅ pTag=true, nprofile decode=true, name=true
- Test scripts: `test-auth-v3.ts`, `test-mention.ts`

## Lessons Learned

### PluginRuntime vs RuntimeEnv

External plugins receive two different runtime objects:

- `api.runtime` (PluginRuntime) — provided in the `register()` callback. This carries the full channel-reply dispatch layer that routes agent replies back through the correct outbound adapter.
- `ctx.runtime` (RuntimeEnv) — provided in the `startAccount()` gateway context. This is a lower-level runtime that lacks the channel dispatch layer.

Using `ctx.runtime` causes replies to fall through to the default channel (e.g. Telegram) instead of being routed back through the NIP-29 outbound adapter. The fix is to store `api.runtime` via `setPluginRuntime()` in `register()` and retrieve it via `getPluginRuntime()` in `startAccount()`.

### handleInboundMessage is NOT part of the SDK

The bundled nostr plugin uses `handleInboundMessage` via unsafe type casts against internal APIs. This function is not exposed by the plugin SDK and does not exist on PluginRuntime. External plugins must use the proper SDK dispatch flow instead.

### Correct SDK inbound flow

The correct sequence for processing inbound messages in an external plugin:

1. `finalizeInboundContext(...)` — build the typed inbound context payload
2. `recordInboundSession(...)` — persist session metadata and update last-route
3. `dispatchReplyWithBufferedBlockDispatcher(...)` — run the agent pipeline and deliver the reply via the `deliver` callback

All three functions are accessed from the PluginRuntime object stored at registration time.

### AUTH polling pattern

The NIP-42 relay challenge (`relay.challenge`) arrives asynchronously after `Relay.connect()` resolves. It may arrive before or after `relay.onauth` fires, depending on relay timing. The plugin handles this with a three-pronged approach:

1. Check `relay.challenge` immediately after connect — if present, auth right away
2. Set `relay.onauth` callback for future challenges
3. Poll every 100ms (up to 5 seconds) checking if `relay.challenge` has appeared

A fixed `setTimeout` delay does not work reliably because challenge timing varies across relays and network conditions.

### Node.js ws package requirement

Node.js lacks a built-in WebSocket implementation compatible with nostr-tools. The plugin uses `require('ws')` (not `import`) and passes it as `websocketImplementation` to `Relay.connect()`. The `require()` form is necessary because the `ws` package's ESM export does not work correctly with nostr-tools' expected constructor signature. Bun's native WebSocket works without this workaround.
