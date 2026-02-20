import {
  buildChannelConfigSchema,
  collectStatusIssuesFromLastError,
  createDefaultChannelRuntimeState,
  DEFAULT_ACCOUNT_ID,
  formatPairingApproveHint,
  type ChannelPlugin,
} from "openclaw/plugin-sdk";
import type { NostrProfile } from "./config-schema.js";
import { NostrConfigSchema } from "./config-schema.js";
import type { MetricEvent, MetricsSnapshot } from "./metrics.js";
import { normalizePubkey, startNostrBus, type NostrBusHandle } from "./nostr-bus.js";
import { decode as nip19decode } from "nostr-tools/nip19";
import { startNip29Bus, type Nip29BusHandle } from "./nip29-bus.js";
import type { ProfilePublishResult } from "./nostr-profile.js";
import { getNostrRuntime } from "./runtime.js";
import {
  listNostrAccountIds,
  resolveDefaultNostrAccountId,
  resolveNostrAccount,
  type ResolvedNostrAccount,
} from "./types.js";

// Store active bus handles per account
const activeBuses = new Map<string, NostrBusHandle>();
const activeNip29Buses = new Map<string, Nip29BusHandle>();

// Store metrics snapshots per account (for status reporting)
const metricsSnapshots = new Map<string, MetricsSnapshot>();

export const nostrPlugin: ChannelPlugin<ResolvedNostrAccount> = {
  id: "nostr",
  meta: {
    id: "nostr",
    label: "Nostr",
    selectionLabel: "Nostr",
    docsPath: "/channels/nostr",
    docsLabel: "nostr",
    blurb: "Decentralized DMs via Nostr relays (NIP-04)",
    order: 100,
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: false, // No media for MVP
  },
  reload: { configPrefixes: ["channels.nostr"] },
  configSchema: buildChannelConfigSchema(NostrConfigSchema),

  config: {
    listAccountIds: (cfg) => listNostrAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveNostrAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultNostrAccountId(cfg),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      publicKey: account.publicKey,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveNostrAccount({ cfg, accountId }).config.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => {
          if (entry === "*") {
            return "*";
          }
          try {
            return normalizePubkey(entry);
          } catch {
            return entry; // Keep as-is if normalization fails
          }
        })
        .filter(Boolean),
  },

  pairing: {
    idLabel: "nostrPubkey",
    normalizeAllowEntry: (entry) => {
      try {
        return normalizePubkey(entry.replace(/^nostr:/i, ""));
      } catch {
        return entry;
      }
    },
    notifyApproval: async ({ id }) => {
      // Get the default account's bus and send approval message
      const bus = activeBuses.get(DEFAULT_ACCOUNT_ID);
      if (bus) {
        await bus.sendDm(id, "Your pairing request has been approved!");
      }
    },
  },

  security: {
    resolveDmPolicy: ({ account }) => {
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: "channels.nostr.dmPolicy",
        allowFromPath: "channels.nostr.allowFrom",
        approveHint: formatPairingApproveHint("nostr"),
        normalizeEntry: (raw) => {
          try {
            return normalizePubkey(raw.replace(/^nostr:/i, "").trim());
          } catch {
            return raw.trim();
          }
        },
      };
    },
  },

  messaging: {
    normalizeTarget: (target) => {
      // Group targets: group:<groupId>
      if (target.startsWith("group:")) return target;
      // Strip nostr: prefix if present
      const cleaned = target.replace(/^nostr:/i, "").trim();
      try {
        return normalizePubkey(cleaned);
      } catch {
        return cleaned;
      }
    },
    targetResolver: {
      looksLikeId: (input) => {
        const trimmed = input.trim();
        return (
          trimmed.startsWith("group:") ||
          trimmed.startsWith("npub1") ||
          /^[0-9a-fA-F]{64}$/.test(trimmed)
        );
      },
      hint: "<npub|hex pubkey|nostr:npub...|group:groupId>",
    },
  },

  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
    sendText: async ({ to, text, accountId }) => {
      const core = getNostrRuntime();
      const aid = accountId ?? DEFAULT_ACCOUNT_ID;
      const tableMode = core.channel.text.resolveMarkdownTableMode({
        cfg: core.config.loadConfig(),
        channel: "nostr",
        accountId: aid,
      });
      const message = core.channel.text.convertMarkdownTables(text ?? "", tableMode);

      // Route group messages to NIP-29 bus
      if (to.startsWith("group:")) {
        const groupId = to.slice("group:".length);
        const nip29Bus = activeNip29Buses.get(aid);
        if (!nip29Bus) {
          throw new Error(`NIP-29 bus not running for account ${aid}`);
        }
        await nip29Bus.sendGroupMessage(groupId, message);
        return {
          channel: "nostr" as const,
          to,
          messageId: `nostr-group-${Date.now()}`,
        };
      }

      const bus = activeBuses.get(aid);
      if (!bus) {
        throw new Error(`Nostr bus not running for account ${aid}`);
      }
      const normalizedTo = normalizePubkey(to);
      await bus.sendDm(normalizedTo, message);
      return {
        channel: "nostr" as const,
        to: normalizedTo,
        messageId: `nostr-${Date.now()}`,
      };
    },
  },

  status: {
    defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
    collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("nostr", accounts),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      publicKey: snapshot.publicKey ?? null,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      publicKey: account.publicKey,
      profile: account.profile,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },

  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.setStatus({
        accountId: account.accountId,
        publicKey: account.publicKey,
      });
      ctx.log?.info(
        `[${account.accountId}] starting Nostr provider (pubkey: ${account.publicKey})`,
      );

      if (!account.configured) {
        throw new Error("Nostr private key not configured");
      }

      const runtime = getNostrRuntime();

      // Track bus handle for metrics callback
      let busHandle: NostrBusHandle | null = null;

      const bus = await startNostrBus({
        accountId: account.accountId,
        privateKey: account.privateKey,
        relays: account.relays,
        onMessage: async (senderPubkey, text, reply) => {
          ctx.log?.debug?.(
            `[${account.accountId}] DM from ${senderPubkey}: ${text.slice(0, 50)}...`,
          );

          // Forward to OpenClaw's message pipeline
          // TODO: Replace with proper dispatchReplyWithBufferedBlockDispatcher call
          await (
            runtime.channel.reply as { handleInboundMessage?: (params: unknown) => Promise<void> }
          ).handleInboundMessage?.({
            channel: "nostr",
            accountId: account.accountId,
            senderId: senderPubkey,
            chatType: "direct",
            chatId: senderPubkey, // For DMs, chatId is the sender's pubkey
            text,
            reply: async (responseText: string) => {
              await reply(responseText);
            },
          });
        },
        onError: (error, context) => {
          ctx.log?.error?.(`[${account.accountId}] Nostr error (${context}): ${error.message}`);
        },
        onConnect: (relay) => {
          ctx.log?.debug?.(`[${account.accountId}] Connected to relay: ${relay}`);
        },
        onDisconnect: (relay) => {
          ctx.log?.debug?.(`[${account.accountId}] Disconnected from relay: ${relay}`);
        },
        onEose: (relays) => {
          ctx.log?.debug?.(`[${account.accountId}] EOSE received from relays: ${relays}`);
        },
        onMetric: (event: MetricEvent) => {
          // Log significant metrics at appropriate levels
          if (event.name.startsWith("event.rejected.")) {
            ctx.log?.debug?.(
              `[${account.accountId}] Metric: ${event.name} ${JSON.stringify(event.labels)}`,
            );
          } else if (event.name === "relay.circuit_breaker.open") {
            ctx.log?.warn?.(
              `[${account.accountId}] Circuit breaker opened for relay: ${event.labels?.relay}`,
            );
          } else if (event.name === "relay.circuit_breaker.close") {
            ctx.log?.info?.(
              `[${account.accountId}] Circuit breaker closed for relay: ${event.labels?.relay}`,
            );
          } else if (event.name === "relay.error") {
            ctx.log?.debug?.(`[${account.accountId}] Relay error: ${event.labels?.relay}`);
          }
          // Update cached metrics snapshot
          if (busHandle) {
            metricsSnapshots.set(account.accountId, busHandle.getMetrics());
          }
        },
      });

      busHandle = bus;

      // Store the bus handle
      activeBuses.set(account.accountId, bus);

      ctx.log?.info(
        `[${account.accountId}] Nostr provider started, connected to ${account.relays.length} relay(s)`,
      );

      // Start NIP-29 group bus if groups are configured
      let nip29Bus: Nip29BusHandle | null = null;
      if (account.groups.length > 0) {
        try {
          nip29Bus = await startNip29Bus({
            privateKey: account.privateKey,
            groups: account.groups,
            accountId: account.accountId,
            onMessage: async ({ groupId, senderPubkey, text, eventId, tags }) => {
              ctx.log?.debug?.(
                `[${account.accountId}] Group ${groupId} msg from ${senderPubkey}: ${text.slice(0, 50)}...`,
              );

              // Mention gating
              const groupCfg = account.groups.find((g) => g.id === groupId);
              const requireMention =
                groupCfg?.mentionOnly ?? account.groupRequireMention;
              if (requireMention) {
                const botPubkey = account.publicKey;
                // Check p-tags for our pubkey (proper NIP-27 mention)
                const pTagMention = tags?.some(
                  (t: string[]) => t[0] === "p" && t[1] === botPubkey,
                );
                // Also check text for nostr: URI containing our pubkey (hex or bech32)
                let textMention = text.includes(botPubkey);
                if (!textMention) {
                  // Decode nostr:nprofile1.../nostr:npub1... URIs and compare hex pubkeys
                  const nostrUriRegex = /nostr:(nprofile|npub)1[a-z0-9]+/gi;
                  const uris = text.match(nostrUriRegex);
                  if (uris) {
                    for (const uri of uris) {
                      const bech32 = uri.replace(/^nostr:/i, "");
                      try {
                        const decoded = nip19decode(bech32);
                        const decodedPubkey =
                          decoded.type === "npub"
                            ? decoded.data
                            : decoded.type === "nprofile"
                              ? (decoded.data as { pubkey: string }).pubkey
                              : null;
                        if (decodedPubkey === botPubkey) {
                          textMention = true;
                          break;
                        }
                      } catch {}
                    }
                  }
                }
                // Fallback: check for bot name in text
                const nameMention = account.name
                  ? text.toLowerCase().includes(account.name.toLowerCase())
                  : false;
                ctx.log?.debug?.(`[${account.accountId}] Mention check: pTag=${pTagMention} text=${textMention} name=${nameMention} botPubkey=${botPubkey?.slice(0,8)}`);
                if (!pTagMention && !textMention && !nameMention) return;
              }

              ctx.log?.debug?.(`[${account.accountId}] Forwarding group msg to agent from ${senderPubkey.slice(0,8)}`);
              await (
                runtime.channel.reply as {
                  handleInboundMessage?: (params: unknown) => Promise<void>;
                }
              ).handleInboundMessage?.({
                channel: "nostr",
                accountId: account.accountId,
                senderId: senderPubkey,
                chatType: "group",
                chatId: `group:${groupId}`,
                text,
                reply: async (responseText: string) => {
                  await nip29Bus!.sendGroupMessage(groupId, responseText);
                },
              });
            },
            onError: (error, context) => {
              ctx.log?.error?.(
                `[${account.accountId}] NIP-29 error (${context}): ${error.message}`,
              );
            },
            onConnect: (relay) => {
              ctx.log?.info?.(
                `[${account.accountId}] NIP-29 connected to relay: ${relay}`,
              );
            },
            onDisconnect: (relay) => {
              ctx.log?.debug?.(
                `[${account.accountId}] NIP-29 disconnected from relay: ${relay}`,
              );
            },
            onEose: (relay) => {
              ctx.log?.debug?.(
                `[${account.accountId}] NIP-29 EOSE from relay: ${relay}`,
              );
            },
          });

          activeNip29Buses.set(account.accountId, nip29Bus);
          ctx.log?.info(
            `[${account.accountId}] NIP-29 group bus started for ${account.groups.length} group(s)`,
          );
        } catch (err) {
          ctx.log?.error?.(
            `[${account.accountId}] Failed to start NIP-29 bus: ${(err as Error).message}`,
          );
        }
      }

      // Keep the channel alive until the abort signal fires.
      // Other channels (telegram, discord, etc.) return a long-lived promise;
      // if we return immediately the channel manager thinks we exited and
      // triggers auto-restart.
      await new Promise<void>((resolve) => {
        if (ctx.abortSignal.aborted) {
          resolve();
          return;
        }
        ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });

      // Cleanup
      bus.close();
      activeBuses.delete(account.accountId);
      metricsSnapshots.delete(account.accountId);
      if (nip29Bus) {
        nip29Bus.close();
        activeNip29Buses.delete(account.accountId);
      }
      ctx.log?.info(`[${account.accountId}] Nostr provider stopped`);
    },
  },
};

/**
 * Get metrics snapshot for a Nostr account.
 * Returns undefined if account is not running.
 */
export function getNostrMetrics(
  accountId: string = DEFAULT_ACCOUNT_ID,
): MetricsSnapshot | undefined {
  const bus = activeBuses.get(accountId);
  if (bus) {
    return bus.getMetrics();
  }
  return metricsSnapshots.get(accountId);
}

/**
 * Get all active Nostr bus handles.
 * Useful for debugging and status reporting.
 */
export function getActiveNostrBuses(): Map<string, NostrBusHandle> {
  return new Map(activeBuses);
}

/**
 * Publish a profile (kind:0) for a Nostr account.
 * @param accountId - Account ID (defaults to "default")
 * @param profile - Profile data to publish
 * @returns Publish results with successes and failures
 * @throws Error if account is not running
 */
export async function publishNostrProfile(
  accountId: string = DEFAULT_ACCOUNT_ID,
  profile: NostrProfile,
): Promise<ProfilePublishResult> {
  const bus = activeBuses.get(accountId);
  if (!bus) {
    throw new Error(`Nostr bus not running for account ${accountId}`);
  }
  return bus.publishProfile(profile);
}

/**
 * Get profile publish state for a Nostr account.
 * @param accountId - Account ID (defaults to "default")
 * @returns Profile publish state or null if account not running
 */
export async function getNostrProfileState(accountId: string = DEFAULT_ACCOUNT_ID): Promise<{
  lastPublishedAt: number | null;
  lastPublishedEventId: string | null;
  lastPublishResults: Record<string, "ok" | "failed" | "timeout"> | null;
} | null> {
  const bus = activeBuses.get(accountId);
  if (!bus) {
    return null;
  }
  return bus.getProfileState();
}
