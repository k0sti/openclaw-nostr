# OpenClaw Nostr NIP-29 Plugin

External OpenClaw channel plugin for NIP-29 group chats on authenticated Nostr relays. Receives group messages, detects bot mentions, dispatches them to OpenClaw agents, and publishes replies back to the group.

## Features

- **NIP-29 group chat support** -- subscribes to kind 9 (chat), 11 (thread root), and 12 (thread reply) events
- **NIP-42 AUTH** -- authenticates with relays that require it, using a polling pattern that handles async challenge delivery
- **Mention detection** -- p-tags, `nostr:nprofile1...` URIs, `nostr:npub1...` URIs, raw hex pubkeys, and bot display name (case-insensitive)
- **Multi-group subscription** -- subscribe to multiple NIP-29 groups on a single relay connection
- **Per-group mention gating** -- each group can independently require or skip mention checks

## Installation

```bash
cp -r . ~/.openclaw/extensions/nostr-nip29/
cd ~/.openclaw/extensions/nostr-nip29/
bun install
```

The plugin is discovered automatically by OpenClaw via the `openclaw.plugin.json` manifest.

## Configuration

Add the following block to your OpenClaw config under `channels`:

```json
{
  "channels": {
    "nostr-nip29": {
      "enabled": true,
      "privateKey": "nsec1...",
      "name": "mybot",
      "relay": "wss://relay.example.com",
      "groups": [
        { "id": "general", "mentionOnly": true },
        { "id": "dev", "mentionOnly": false }
      ],
      "groupAllowFrom": ["*"],
      "groupRequireMention": true
    }
  }
}
```

### Config Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable or disable the plugin |
| `privateKey` | string | (required) | Bot's secret key in `nsec1...` format |
| `name` | string | `"nostr-nip29"` | Bot display name, used for name-based mention detection |
| `relay` | string | (required) | Relay WebSocket URL (`wss://...`) |
| `groups` | array | `[]` | Array of group objects to subscribe to |
| `groups[].id` | string | (required) | NIP-29 group identifier (the `h` tag value) |
| `groups[].mentionOnly` | boolean | inherits `groupRequireMention` | Override mention requirement per group |
| `groupAllowFrom` | string[] | `["*"]` | Hex pubkeys allowed to trigger the bot, or `["*"]` for all |
| `groupRequireMention` | boolean | `true` | Require the bot to be mentioned before responding |

## CLI: Send Messages from Any Context

The `bin/nostr-send.ts` script sends messages to NIP-29 groups from any context (shell, cron, other bots). This bypasses OpenClaw's cross-context message restrictions.

```bash
# Basic usage
bun run bin/nostr-send.ts <group> <message>

# Examples
bun run bin/nostr-send.ts techteam "Hello from Telegram!"
bun run bin/nostr-send.ts general "Scheduled alert: deploy complete"

# Override relay
NOSTR_RELAY=wss://other-relay.example.com bun run bin/nostr-send.ts dev "test"
```

### Config

The script reads the bot's secret key from (in order):
1. `NOSTR_NSEC` environment variable
2. `~/openclaw/.secrets/nostr.json` (`{"nsec": "nsec1..."}`)

Relay defaults to `wss://zooid.atlantislabs.space`. Override with `NOSTR_RELAY`.

## Architecture

### Inbound Flow

1. Connect to relay and authenticate via NIP-42 AUTH
2. Subscribe to configured groups (kinds 9/11/12 filtered by `#h` tags)
3. On receiving an event: skip own pubkey, check allowlist, check mention gate
4. Build inbound context via `finalizeInboundContext`
5. Record session via `recordInboundSession`
6. Dispatch to agent via `dispatchReplyWithBufferedBlockDispatcher`
7. Agent processes message and produces a reply

### Outbound Flow

1. Agent reply arrives at the `deliver` callback (inside the dispatcher) or `outbound.sendText`
2. Build a kind 9 event with `["h", groupId]` tag
3. Sign with the bot's secret key and publish to relay

### Session Keys

Sessions are keyed as `agent:<agentId>:nostr-nip29:group:<groupId>`, resolved by `resolveAgentRoute`.

## Key Technical Notes

- **Node.js ws package**: Node.js does not have a native WebSocket implementation compatible with nostr-tools. The plugin uses `require('ws')` and passes it as the `websocketImplementation` option to `Relay.connect()`.

- **AUTH polling**: The relay challenge string (`relay.challenge`) arrives asynchronously after `Relay.connect()` resolves. The plugin patches `relay.auth` immediately, handles challenges in `relay.onauth`, and polls every 100ms (up to 5 seconds) for the challenge to arrive. This covers relays where the challenge arrives after connect but before `onauth` fires.

- **SDK dispatch flow**: The correct inbound processing sequence is:
  1. `finalizeInboundContext` -- build the typed context payload
  2. `recordInboundSession` -- persist session metadata
  3. `dispatchReplyWithBufferedBlockDispatcher` -- run the agent and deliver the reply

  Do NOT use `handleInboundMessage` -- it is not part of the OpenClaw plugin SDK.

- **PluginRuntime vs RuntimeEnv**: External plugins must use `api.runtime` (PluginRuntime) from the `register()` callback, not `ctx.runtime` (RuntimeEnv) from the gateway context. The PluginRuntime carries the channel-reply dispatch layer that routes agent replies through the correct outbound adapter. Using `ctx.runtime` causes replies to fall through to the default channel.

- **Runtime storage pattern**: `setPluginRuntime(api.runtime)` is called in `register()`. `getPluginRuntime()` is called in `startAccount()` to retrieve it.

## Testing

Run all tests with:

```bash
bun test
```

### Test Suites

- **`test/mentions.test.ts`** -- Unit tests for all mention detection paths: p-tag, hex pubkey in text, npub URI, nprofile URI, bot name (case-insensitive), no mention, missing botName, invalid URIs, and multiple simultaneous mentions. Runs offline, no relay needed.

- **`test/relay.test.ts`** -- Integration tests against a live relay. Tests `decodeNsec`, and the full connect/auth/subscribe/EOSE cycle.

- **`test/roundtrip.test.ts`** -- Full roundtrip test: bot subscribes, a second keypair sends a mention to the group, bot receives and detects it, bot publishes a reply. Requires relay membership.

- **`test/e2e.test.ts`** -- End-to-end test using an external posting tool. Verifies the bot receives mentions from a real sender and can publish replies.

## Development

The `reference/` directory contains the bundled OpenClaw nostr plugin source and SDK type definitions. These files are not part of this plugin's runtime but serve as development context for understanding the PluginRuntime API, ChannelPlugin interface, and the correct dispatch patterns.

## File Structure

```
openclaw-nostr/
  openclaw.plugin.json     # Plugin manifest
  index.ts                 # Plugin entry point (register + runtime setup)
  package.json
  bin/
    nostr-send.ts          # Standalone CLI for sending NIP-29 group messages
  src/
    plugin.ts              # ChannelPlugin implementation
    relay.ts               # Relay connection, NIP-42 AUTH, NIP-29 subscription
    mentions.ts            # Mention detection (p-tag, bech32, hex, name)
    config.ts              # Config resolution and account listing
    types.ts               # Shared TypeScript interfaces
    runtime.ts             # PluginRuntime storage (set in register, get in gateway)
  test/
    mentions.test.ts       # Mention detection unit tests
    relay.test.ts          # Relay connection integration tests
    roundtrip.test.ts      # Full send/receive/reply cycle
    e2e.test.ts            # End-to-end with external sender
  reference/               # Bundled plugin source + SDK types (dev context only)
  DESIGN.md                # Design document and architecture notes
```
