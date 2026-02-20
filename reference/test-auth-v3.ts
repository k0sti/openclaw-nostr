#!/usr/bin/env bun
/**
 * Test v3: patch relay immediately after connect, before any async gap
 */
import { Relay } from "nostr-tools/relay";
import { finalizeEvent, getPublicKey } from "nostr-tools";
import { decode as decodeBech32 } from "nostr-tools/nip19";

const nsec = "nsec1536kja454h2shw3ztx6evvrkz29n2t24p28r8m7l2lhm9j5uy2wq6040j7";
const { data: sk } = decodeBech32(nsec) as { data: Uint8Array };
const pk = getPublicKey(sk);

console.log("pubkey:", pk);

// Create relay with onauth already set via connect callback
const relay = await Relay.connect("wss://zooid.atlantislabs.space");
console.log("✓ connected, challenge:", relay.challenge ? "yes" : "no");

// Patch relay.auth immediately
const origAuth = relay.auth.bind(relay);
relay.auth = async (_signer?: any) => origAuth(async (evt: any) => finalizeEvent(evt, sk));

// If challenge already arrived during connect, auth now
if (relay.challenge) {
  console.log("challenge already present, authing...");
  try { await relay.auth(); console.log("✓ AUTH done"); } catch (e) { console.log("AUTH err:", e); }
}

// Also handle future auth challenges
relay.onauth = async () => {
  console.log("onauth fired");
  try { await relay.auth(); console.log("✓ AUTH done (onauth)"); } catch (e) { console.log("AUTH err:", e); }
};

// Wait for auth to settle
await new Promise(r => setTimeout(r, 2000));

console.log("subscribing...");
const sub = relay.subscribe(
  [{ kinds: [9, 11, 12], "#h": ["techteam"], limit: 3 }],
  {
    onevent: (event) => {
      console.log(`✓ event: kind=${event.kind} from=${event.pubkey.slice(0, 8)} "${event.content.slice(0, 60)}"`);
    },
    oneose: () => console.log("✓ EOSE"),
    onclose: (reason) => console.log("✗ closed:", reason),
  }
);

setTimeout(() => {
  console.log("✓ done — no crash!");
  sub.close();
  relay.close();
  process.exit(0);
}, 8000);
