import { Relay } from "nostr-tools/relay";
import { finalizeEvent, getPublicKey, type Event } from "nostr-tools";
import { validatePrivateKey } from "./nostr-bus.js";
import {
  readNostrBusState,
  writeNostrBusState,
  computeSinceTimestamp,
} from "./nostr-state-store.js";
import { createSeenTracker, type SeenTracker } from "./seen-tracker.js";

// NIP-29 group chat kinds
const KIND_GROUP_CHAT = 9;
const KIND_GROUP_THREAD_ROOT = 11;
const KIND_GROUP_THREAD_REPLY = 12;

const GROUP_KINDS = [KIND_GROUP_CHAT, KIND_GROUP_THREAD_ROOT, KIND_GROUP_THREAD_REPLY];

const STARTUP_LOOKBACK_SEC = 60;
const MAX_PERSISTED_EVENT_IDS = 5000;
const STATE_PERSIST_DEBOUNCE_MS = 5000;

export interface Nip29GroupConfig {
  id: string;
  relay: string;
  mentionOnly?: boolean;
}

export interface Nip29BusOptions {
  privateKey: string;
  groups: Nip29GroupConfig[];
  accountId?: string;
  onMessage: (params: {
    groupId: string;
    relayUrl: string;
    senderPubkey: string;
    text: string;
    kind: number;
    eventId: string;
    tags: string[][];
  }) => Promise<void>;
  onError?: (error: Error, context: string) => void;
  onConnect?: (relay: string) => void;
  onDisconnect?: (relay: string) => void;
  onEose?: (relay: string) => void;
}

export interface Nip29BusHandle {
  close: () => void;
  publicKey: string;
  sendGroupMessage: (groupId: string, text: string) => Promise<void>;
}

export async function startNip29Bus(options: Nip29BusOptions): Promise<Nip29BusHandle> {
  const {
    privateKey,
    groups,
    onMessage,
    onError,
    onConnect,
    onDisconnect,
    onEose,
  } = options;

  const sk = validatePrivateKey(privateKey);
  const pk = getPublicKey(sk);
  const accountId = options.accountId ?? pk.slice(0, 16);
  const stateKey = `nip29-${accountId}`;
  const gatewayStartedAt = Math.floor(Date.now() / 1000);

  // Seen tracker for dedup
  const seen: SeenTracker = createSeenTracker({
    maxEntries: 100_000,
    ttlMs: 60 * 60 * 1000,
  });

  // State persistence
  const state = await readNostrBusState({ accountId: stateKey });
  const baseSince = computeSinceTimestamp(state, gatewayStartedAt);
  const since = Math.max(0, baseSince - STARTUP_LOOKBACK_SEC);

  if (state?.recentEventIds?.length) {
    seen.seed(state.recentEventIds);
  }

  await writeNostrBusState({
    accountId: stateKey,
    lastProcessedAt: state?.lastProcessedAt ?? gatewayStartedAt,
    gatewayStartedAt,
    recentEventIds: state?.recentEventIds ?? [],
  });

  let pendingWrite: ReturnType<typeof setTimeout> | undefined;
  let lastProcessedAt = state?.lastProcessedAt ?? gatewayStartedAt;
  let recentEventIds = (state?.recentEventIds ?? []).slice(-MAX_PERSISTED_EVENT_IDS);

  function scheduleStatePersist(eventCreatedAt: number, eventId: string): void {
    lastProcessedAt = Math.max(lastProcessedAt, eventCreatedAt);
    recentEventIds.push(eventId);
    if (recentEventIds.length > MAX_PERSISTED_EVENT_IDS) {
      recentEventIds = recentEventIds.slice(-MAX_PERSISTED_EVENT_IDS);
    }
    if (pendingWrite) clearTimeout(pendingWrite);
    pendingWrite = setTimeout(() => {
      writeNostrBusState({
        accountId: stateKey,
        lastProcessedAt,
        gatewayStartedAt,
        recentEventIds,
      }).catch((err) => onError?.(err as Error, "persist nip29 state"));
    }, STATE_PERSIST_DEBOUNCE_MS);
  }

  // Group relays by URL
  const relayGroups = new Map<string, string[]>();
  const groupRelayMap = new Map<string, string>();
  for (const g of groups) {
    const existing = relayGroups.get(g.relay) ?? [];
    existing.push(g.id);
    relayGroups.set(g.relay, existing);
    groupRelayMap.set(g.id, g.relay);
  }

  const relayInstances: Relay[] = [];
  const subscriptions: Array<{ close: () => void }> = [];

  for (const [relayUrl, groupIds] of relayGroups) {
    try {
      const relay = await Relay.connect(relayUrl);
      relayInstances.push(relay);
      onConnect?.(relayUrl);

      relay.onclose = () => {
        onDisconnect?.(relayUrl);
      };

      // NIP-42 AUTH: patch relay.auth to always use our signer.
      // nostr-tools has a bug where signAuthEvent=undefined causes an uncaught
      // TypeError (evt.id on undefined) in a setTimeout. By always injecting
      // our signer, both explicit and internal auth attempts succeed.
      const origAuth = relay.auth.bind(relay);
      relay.auth = async (_signAuthEvent?: any) => {
        return origAuth(async (evt: any) => finalizeEvent(evt, sk));
      };

      // Handle future auth challenges
      relay.onauth = async () => {
        try { await relay.auth(); } catch { /* non-fatal */ }
      };

      // Wait for the AUTH challenge to arrive and complete before subscribing.
      // Relays like zooid send AUTH immediately after connect; if we subscribe
      // before the handshake finishes, the relay rejects with auth-required.
      if ((relay as any).challenge) {
        try { await relay.auth(); } catch { /* non-fatal */ }
      } else {
        // Give the relay a moment to send the AUTH challenge
        await new Promise<void>((resolve) => {
          const prevOnauth = relay.onauth;
          const timeout = setTimeout(() => {
            relay.onauth = prevOnauth;
            resolve();
          }, 2000);
          relay.onauth = async () => {
            clearTimeout(timeout);
            try { await relay.auth(); } catch { /* non-fatal */ }
            relay.onauth = prevOnauth;
            resolve();
          };
        });
      }

      // Sub to group messages
      const sub = relay.subscribe(
        [
          {
            kinds: GROUP_KINDS,
            "#h": groupIds,
            since,
          },
        ],
        {
          onevent: async (event: Event) => {
            try {
              if (seen.peek(event.id)) return;
              seen.add(event.id);

              if (event.pubkey === pk) return;

              const groupTag = event.tags.find((t: string[]) => t[0] === "h");
              const groupId = groupTag?.[1];
              if (!groupId || !groupIds.includes(groupId)) return;

              await onMessage({
                groupId,
                relayUrl,
                senderPubkey: event.pubkey,
                text: event.content,
                kind: event.kind,
                eventId: event.id,
                tags: event.tags,
              });

              scheduleStatePersist(event.created_at, event.id);
            } catch (err) {
              onError?.(err as Error, `nip29 event ${event.id}`);
            }
          },
          oneose: () => {
            onEose?.(relayUrl);
          },
          onclose: (reason: string) => {
            onError?.(new Error(`NIP-29 subscription closed: ${reason}`), "nip29 subscription");
          },
        },
      );

      subscriptions.push(sub);
    } catch (err) {
      onError?.(err as Error, `connect to ${relayUrl}`);
    }
  }

  const sendGroupMessage = async (groupId: string, text: string): Promise<void> => {
    const relayUrl = groupRelayMap.get(groupId);
    if (!relayUrl) throw new Error(`No relay configured for group ${groupId}`);

    const relay = relayInstances.find(
      (r) => r.url === relayUrl || r.url === relayUrl.replace(/\/$/, ""),
    );
    if (!relay?.connected) throw new Error(`Not connected to relay ${relayUrl}`);

    const event = finalizeEvent(
      {
        kind: KIND_GROUP_CHAT,
        content: text,
        tags: [["h", groupId]],
        created_at: Math.floor(Date.now() / 1000),
      },
      sk,
    );

    await relay.publish(event);
  };

  return {
    close: () => {
      for (const sub of subscriptions) sub.close();
      for (const relay of relayInstances) relay.close();
      seen.stop();
      if (pendingWrite) {
        clearTimeout(pendingWrite);
        writeNostrBusState({
          accountId: stateKey,
          lastProcessedAt,
          gatewayStartedAt,
          recentEventIds,
        }).catch((err) => onError?.(err as Error, "persist nip29 state on close"));
      }
    },
    publicKey: pk,
    sendGroupMessage,
  };
}
