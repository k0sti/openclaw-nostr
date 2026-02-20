#!/usr/bin/env bun
/**
 * Standalone test: connect to zooid with AUTH, subscribe to #techteam,
 * test mention detection logic.
 */
import { Relay } from "nostr-tools/relay";
import { finalizeEvent, getPublicKey } from "nostr-tools";
import { decode as nip19decode } from "nostr-tools/nip19";

const RELAY = "wss://zooid.atlantislabs.space";
const GROUP = "techteam";
const nsec = "nsec1536kja454h2shw3ztx6evvrkz29n2t24p28r8m7l2lhm9j5uy2wq6040j7";
const { data: SK } = nip19decode(nsec) as { data: Uint8Array };
const BOT_PUBKEY = getPublicKey(SK);
const BOT_NAME = "clarity";

console.log(`Bot pubkey: ${BOT_PUBKEY}`);
console.log(`Connecting to ${RELAY}...`);

const relay = await Relay.connect(RELAY);
console.log(`Connected. Challenge: ${relay.challenge ? "yes" : "no"}`);

// Patch auth
const origAuth = relay.auth.bind(relay);
relay.auth = async (_signer?: any) => origAuth(async (evt: any) => finalizeEvent(evt, SK));

// Auth if challenge present
if (relay.challenge) {
  try { await relay.auth(); console.log("✓ AUTH done"); } catch (e) { console.log("AUTH err:", e); }
}
relay.onauth = async () => {
  try { await relay.auth(); console.log("✓ AUTH done (onauth)"); } catch (e) { console.log("AUTH err:", e); }
};

// Wait for auth to settle
await new Promise(r => setTimeout(r, 2000));

console.log(`Subscribing to #${GROUP}...`);

const sub = relay.subscribe(
  [{ kinds: [9, 11, 12], "#h": [GROUP], since: Math.floor(Date.now() / 1000) }],
  {
    onevent: (event) => {
      console.log(`\n--- Event ${event.id.slice(0, 8)} ---`);
      console.log(`  From: ${event.pubkey.slice(0, 16)}...`);
      console.log(`  Text: ${event.content}`);
      console.log(`  Tags: ${JSON.stringify(event.tags)}`);

      if (event.pubkey === BOT_PUBKEY) {
        console.log(`  → Skipped (own message)`);
        return;
      }

      // === Mention detection ===
      const tags = event.tags;
      const text = event.content;

      // 1. p-tag check
      const pTagMention = tags?.some(
        (t: string[]) => t[0] === "p" && t[1] === BOT_PUBKEY
      );

      // 2. hex pubkey in text
      let textMention = text.includes(BOT_PUBKEY);

      // 3. bech32 decode
      if (!textMention) {
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
              console.log(`  → Decoded ${bech32.slice(0, 20)}... → ${decodedPubkey?.slice(0, 16)}`);
              if (decodedPubkey === BOT_PUBKEY) {
                textMention = true;
                break;
              }
            } catch (e) {
              console.log(`  → Decode error: ${e}`);
            }
          }
        }
      }

      // 4. name check
      const nameMention = text.toLowerCase().includes(BOT_NAME);

      console.log(`  → pTag=${pTagMention} text=${textMention} name=${nameMention}`);
      
      if (pTagMention || textMention || nameMention) {
        console.log(`  ✅ MENTION DETECTED — would forward to agent`);
      } else {
        console.log(`  ❌ No mention — would skip`);
      }
    },
    oneose: () => {
      console.log("EOSE — listening for new messages. Send a mention in #techteam...");
    },
    onclose: (reason) => {
      console.log(`Subscription closed: ${reason}`);
    },
  }
);

process.on("SIGINT", () => {
  console.log("\nClosing...");
  sub.close();
  relay.close();
  process.exit(0);
});
