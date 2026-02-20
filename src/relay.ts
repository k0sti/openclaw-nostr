/**
 * Relay connection with NIP-42 AUTH for NIP-29 group chats.
 * Single relay, single connection. Proven pattern from test-auth-v3.ts.
 */
import { Relay } from "nostr-tools/relay";
import WebSocketImpl from "ws";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { decode as nip19decode } from "nostr-tools/nip19";
import type { Event } from "nostr-tools/pure";

// NIP-29 group chat kinds
const KIND_GROUP_CHAT = 9;
const KIND_GROUP_THREAD_ROOT = 11;
const KIND_GROUP_THREAD_REPLY = 12;
export const GROUP_KINDS = [KIND_GROUP_CHAT, KIND_GROUP_THREAD_ROOT, KIND_GROUP_THREAD_REPLY];

export interface RelayOptions {
  relayUrl: string;
  nsec: string;
  groups: string[];
  onEvent: (event: Event, groupId: string) => void;
  onEose?: () => void;
  onError?: (error: Error, context: string) => void;
  /** Seconds to look back on subscribe. Default: 0 (only new events) */
  since?: number;
}

export interface RelayHandle {
  relay: Relay;
  publicKey: string;
  secretKey: Uint8Array;
  close: () => void;
  publish: (event: Event) => Promise<void>;
  sendGroupMessage: (groupId: string, text: string) => Promise<Event>;
}

/** Decode nsec to raw secret key bytes */
export function decodeNsec(nsec: string): Uint8Array {
  const decoded = nip19decode(nsec);
  if (decoded.type !== "nsec") throw new Error(`Expected nsec, got ${decoded.type}`);
  return decoded.data as Uint8Array;
}

/** Connect to relay, authenticate, subscribe to groups */
export async function connectRelay(opts: RelayOptions): Promise<RelayHandle> {
  const sk = decodeNsec(opts.nsec);
  const pk = getPublicKey(sk);

  const relay = await Relay.connect(opts.relayUrl, {
    websocketImplementation: WebSocketImpl as any,
  });

  // Patch relay.auth immediately to inject our signer (proven pattern)
  const origAuth = relay.auth.bind(relay);
  relay.auth = async (_signer?: any) =>
    origAuth(async (evt: any) => finalizeEvent(evt, sk));

  // If challenge already arrived during connect, auth now
  if (relay.challenge) {
    try {
      await relay.auth();
    } catch (e) {
      opts.onError?.(e as Error, "auth-immediate");
    }
  }

  // Handle future auth challenges + track auth completion
  let authDone = !!relay.challenge; // if we already authed above
  relay.onauth = async () => {
    try {
      await relay.auth();
      authDone = true;
    } catch (e) {
      opts.onError?.(e as Error, "auth-onauth");
      authDone = true; // proceed even on error
    }
  };

  // Wait for auth to complete (up to 5s, check every 100ms)
  // Also check relay.challenge in case it arrives late
  for (let i = 0; i < 50 && !authDone; i++) {
    await new Promise((r) => setTimeout(r, 100));
    // Challenge might arrive after connect — try auth if we see it
    if (!authDone && relay.challenge) {
      try {
        await relay.auth();
        authDone = true;
      } catch (e) {
        opts.onError?.(e as Error, "auth-poll");
        authDone = true;
      }
    }
  }
  if (!authDone) {
    opts.onError?.(new Error("AUTH timeout — proceeding without auth"), "auth-timeout");
  }

  // Subscribe to NIP-29 group messages
  const since = opts.since ?? Math.floor(Date.now() / 1000);
  const sub = relay.subscribe(
    [{ kinds: GROUP_KINDS, "#h": opts.groups, since }],
    {
      onevent: (event: Event) => {
        const groupTag = event.tags.find((t) => t[0] === "h");
        const groupId = groupTag?.[1];
        if (groupId) {
          opts.onEvent(event, groupId);
        }
      },
      oneose: () => opts.onEose?.(),
      onclose: (reason) =>
        opts.onError?.(new Error(`Subscription closed: ${reason}`), "subscription"),
    },
  );

  const sendGroupMessage = async (groupId: string, text: string): Promise<Event> => {
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
    return event;
  };

  return {
    relay,
    publicKey: pk,
    secretKey: sk,
    close: () => {
      sub.close();
      relay.close();
    },
    publish: async (event: Event) => {
      await relay.publish(event);
    },
    sendGroupMessage,
  };
}
