/**
 * NIP-29 Nostr ChannelPlugin implementation.
 * Connects to a single relay, subscribes to NIP-29 groups,
 * forwards inbound mentions to OpenClaw, sends outbound via kind 9.
 */
import type { ChannelPlugin } from "openclaw/plugin-sdk";
import { listAccountIds, resolveAccount } from "./config.js";
import { connectRelay, type RelayHandle } from "./relay.js";
import { checkMention } from "./mentions.js";
import { getPluginRuntime } from "./runtime.js";
import type { NostrNip29Account } from "./types.js";

// Active relay handle per account
const activeHandles = new Map<string, RelayHandle>();

export const nostrNip29Plugin: ChannelPlugin<NostrNip29Account> = {
  id: "nostr-nip29",

  meta: {
    id: "nostr-nip29",
    label: "Nostr NIP-29",
    selectionLabel: "Nostr NIP-29",
    docsPath: "/channels/nostr-nip29",
    docsLabel: "nostr-nip29",
    blurb: "NIP-29 group chats on Nostr relays",
    order: 101,
  },

  capabilities: {
    chatTypes: ["group"],
    media: false,
  },

  reload: { configPrefixes: ["channels.nostr-nip29"] },

  config: {
    listAccountIds: (cfg) => listAccountIds(cfg as Record<string, any>),
    resolveAccount: (cfg, accountId) =>
      resolveAccount(cfg as Record<string, any>, accountId),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      publicKey: account.publicKey,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      resolveAccount(cfg as Record<string, any>, accountId).groupAllowFrom,
  },

  security: {
    resolveDmPolicy: ({ account }) => ({
      policy: "allowlist",
      allowFrom: account.groupAllowFrom,
      allowFromPath: "channels.nostr-nip29.groupAllowFrom",
      approveHint: "Add pubkey to channels.nostr-nip29.groupAllowFrom",
    }),
  },

  messaging: {
    normalizeTarget: (target) => {
      if (target.startsWith("group:")) return target;
      return target;
    },
    targetResolver: {
      looksLikeId: (input) => input.trim().startsWith("group:"),
      hint: "<group:groupId>",
    },
  },

  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
    sendText: async ({ to, text, accountId }) => {
      const aid = accountId ?? "default";
      console.log(
        `[nostr-nip29:outbound] sendText called — to=${to} accountId=${aid} textLen=${text?.length ?? 0}`,
      );
      const handle = activeHandles.get(aid);
      if (!handle) {
        throw new Error(`NIP-29 relay not connected for account ${aid}`);
      }
      if (!to.startsWith("group:")) {
        throw new Error(`NIP-29 outbound only supports group targets, got: ${to}`);
      }
      const groupId = to.slice("group:".length);
      console.log(
        `[nostr-nip29:outbound] Publishing kind 9 to group=${groupId}`,
      );
      await handle.sendGroupMessage(groupId, text ?? "");
      console.log(
        `[nostr-nip29:outbound] Published successfully to group=${groupId}`,
      );
      return {
        channel: "nostr-nip29" as const,
        to,
        messageId: `nip29-${Date.now()}`,
      };
    },
  },

  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account as NostrNip29Account;
      const aid = account.accountId;

      ctx.setStatus({
        accountId: aid,
        publicKey: account.publicKey,
      });

      ctx.log?.info(`[${aid}] Starting NIP-29 gateway (pubkey: ${account.publicKey})`);

      if (!account.configured) {
        throw new Error("NIP-29: privateKey or relay not configured");
      }

      if (account.groups.length === 0) {
        ctx.log?.warn(`[${aid}] No groups configured — gateway will idle`);
      }

      const groupIds = account.groups.map((g) => g.id);

      // Use PluginRuntime from api.runtime (stored at register time),
      // NOT ctx.runtime (RuntimeEnv).  The PluginRuntime carries the
      // channel-reply dispatch layer that routes agent replies back
      // through our outbound adapter.  ctx.runtime lacks this and
      // causes replies to fall through to the default channel.
      const pluginRuntime = getPluginRuntime();

      // Destructure SDK functions from PluginRuntime
      const { loadConfig } = pluginRuntime.config;
      const { resolveAgentRoute } = pluginRuntime.channel.routing;
      const {
        finalizeInboundContext,
        dispatchReplyWithBufferedBlockDispatcher,
      } = pluginRuntime.channel.reply;
      const { recordInboundSession } = pluginRuntime.channel.session;
      const { resolveStorePath } = pluginRuntime.channel.session;

      const handle = await connectRelay({
        relayUrl: account.relay,
        nsec: account.privateKey,
        groups: groupIds,
        since: Math.floor(Date.now() / 1000),
        onEvent: async (event, groupId) => {
          // Skip own messages
          if (event.pubkey === account.publicKey) return;

          const text = event.content;

          // Mention gating
          const groupCfg = account.groups.find((g) => g.id === groupId);
          const requireMention =
            groupCfg?.mentionOnly ?? account.groupRequireMention;

          if (requireMention) {
            const result = checkMention({
              tags: event.tags,
              text,
              botPubkey: account.publicKey!,
              botName: account.name,
            });
            ctx.log?.debug?.(
              `[${aid}] Mention check group=${groupId}: pTag=${result.pTag} text=${result.textHex || result.textBech32} name=${result.name}`,
            );
            if (!result.mentioned) return;
          }

          // Allowlist check
          if (
            !account.groupAllowFrom.includes("*") &&
            !account.groupAllowFrom.includes(event.pubkey)
          ) {
            ctx.log?.debug?.(`[${aid}] Sender ${event.pubkey.slice(0, 8)} not in allowFrom`);
            return;
          }

          ctx.log?.info(
            `[${aid}] Inbound from ${event.pubkey.slice(0, 8)} in group ${groupId}`,
          );

          // --- Proper SDK inbound flow ---
          // 1. Load config & resolve agent route
          const cfg = loadConfig();
          const nostrTo = `group:${groupId}`;
          const route = resolveAgentRoute({
            cfg,
            channel: "nostr-nip29",
            accountId: aid,
            peer: { kind: "group", id: groupId },
          });

          ctx.log?.debug?.(
            `[${aid}] Resolved route: agent=${route.agentId} session=${route.sessionKey}`,
          );

          // 2. Build & finalize inbound context
          const ctxPayload = finalizeInboundContext({
            Body: text,
            BodyForAgent: text,
            RawBody: text,
            CommandBody: text,
            From: `nostr-nip29:group:${groupId}`,
            To: nostrTo,
            SessionKey: route.sessionKey,
            AccountId: route.accountId,
            ChatType: "group",
            ConversationLabel: `nostr-nip29:${groupId}`,
            GroupSubject: groupId,
            SenderName: event.pubkey.slice(0, 8),
            SenderId: event.pubkey,
            Provider: "nostr-nip29",
            Surface: "nostr-nip29",
            WasMentioned: true,
            MessageSid: event.id,
            Timestamp: event.created_at ? event.created_at * 1000 : undefined,
            CommandAuthorized: true,
            OriginatingChannel: "nostr-nip29",
            OriginatingTo: nostrTo,
          });

          // 3. Record inbound session
          const storePath = resolveStorePath(undefined, {
            agentId: route.agentId,
          });
          await recordInboundSession({
            storePath,
            sessionKey: route.sessionKey,
            ctx: ctxPayload,
            updateLastRoute: {
              sessionKey: route.sessionKey,
              channel: "nostr-nip29",
              to: nostrTo,
              accountId: route.accountId,
            },
            onRecordError: (err: unknown) => {
              ctx.log?.warn?.(
                `[${aid}] Failed updating session meta: ${String(err)}`,
              );
            },
          });

          // 4. Dispatch reply through the proper SDK pipeline.
          //    The deliver callback sends the agent's response back to the
          //    Nostr group via our relay handle.  This replaces the broken
          //    handleInboundMessage pattern.
          ctx.log?.debug?.(
            `[${aid}] Dispatching via dispatchReplyWithBufferedBlockDispatcher: session=${route.sessionKey}`,
          );

          try {
            await dispatchReplyWithBufferedBlockDispatcher({
              ctx: ctxPayload,
              cfg,
              dispatcherOptions: {
                deliver: async (payload: any) => {
                  const replyText: string =
                    payload.text ?? payload.body ?? "";
                  if (!replyText) return;
                  ctx.log?.debug?.(
                    `[${aid}] Delivering reply to group=${groupId} (${replyText.length} chars)`,
                  );
                  await handle.sendGroupMessage(groupId, replyText);
                },
                onError: (err: unknown) => {
                  ctx.log?.error?.(
                    `[${aid}] Reply dispatch error: ${String(err)}`,
                  );
                },
              },
            });
          } catch (err) {
            ctx.log?.error?.(
              `[${aid}] dispatchReplyWithBufferedBlockDispatcher failed: ${String(err)}`,
            );
          }
        },
        onEose: () => {
          ctx.log?.debug?.(`[${aid}] EOSE received — subscribed to ${groupIds.length} group(s)`);
        },
        onError: (error, context) => {
          ctx.log?.error?.(`[${aid}] Relay error (${context}): ${error.message}`);
        },
      });

      activeHandles.set(aid, handle);
      ctx.log?.info(
        `[${aid}] NIP-29 gateway started — relay: ${account.relay}, groups: ${groupIds.join(", ")}`,
      );

      // Keep alive until abort signal
      await new Promise<void>((resolve) => {
        if (ctx.abortSignal.aborted) {
          resolve();
          return;
        }
        ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });

      // Cleanup
      handle.close();
      activeHandles.delete(aid);
      ctx.log?.info(`[${aid}] NIP-29 gateway stopped`);
    },
  },
};
