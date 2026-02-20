# Research: Proper Inbound Message Handling

## Problem
`handleInboundMessage` is NOT part of the public plugin SDK. It's an undocumented internal API used by the bundled nostr plugin via unsafe type casts. This is why replies don't route back to our plugin's outbound adapter.

## Correct Approach
The PluginRuntime exposes these functions for inbound message processing:

### `runtime.channel.reply.finalizeInboundContext(params)`
Builds the inbound context (envelope, session key, agent routing, etc.)

### `runtime.channel.reply.dispatchReplyFromConfig(params)`  
Dispatches the reply through the correct outbound adapter based on channel routing.

### `runtime.channel.session.recordInboundSession(params)`
Records the session for the inbound message.

### `runtime.channel.routing.resolveAgentRoute(params)`
Resolves which agent handles this message.

## Session Key Format (from docs)
Group sessions: `agent:<agentId>:<channel>:group:<id>`
Example: `agent:main:nostr-nip29:group:techteam`

## Group Policy (from docs)
- `groupPolicy: "allowlist"` (default) — only allow listed groups
- `groupAllowFrom` — allowed sender pubkeys
- `groups: { "<id>": { requireMention: true } }` — per-group config

## How Built-in Channels Work
Telegram/Discord/WhatsApp all use the `dispatchReplyFromConfig` flow:
1. Receive message from platform
2. Build inbound context with `finalizeInboundContext`
3. Resolve agent route
4. Dispatch through `dispatchReplyFromConfig`
5. Reply automatically routes back through the channel's outbound adapter

## Key Insight
External plugins should use `dispatchReplyFromConfig` instead of `handleInboundMessage`.
The outbound adapter's `sendText` will be called automatically when the agent responds,
because the session was created with the correct channel ID.

## PluginRuntime.channel.reply Functions
- `dispatchReplyWithBufferedBlockDispatcher` — main dispatch with buffering
- `createReplyDispatcherWithTyping` — create dispatcher with typing indicators
- `dispatchReplyFromConfig` — dispatch from config (the right one)
- `finalizeInboundContext` — finalize inbound context
- `formatAgentEnvelope` — format the agent envelope
- `formatInboundEnvelope` — format inbound envelope (deprecated)
- `resolveEnvelopeFormatOptions` — resolve envelope format options
