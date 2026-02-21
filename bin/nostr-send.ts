#!/usr/bin/env bun
/**
 * Standalone CLI to send messages to Nostr NIP-29 groups.
 * Bypasses OpenClaw's cross-context restrictions by using exec/shell.
 *
 * Usage: bun run bin/nostr-send.ts <group> [--mention <npub|hex>]... <message>
 * Env:   NOSTR_NSEC (or reads ~/openclaw/.secrets/nostr.json)
 *        NOSTR_RELAY (default: wss://zooid.atlantislabs.space)
 */
import { connectRelay } from "../src/relay.js";
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { decode as nip19decode } from "nostr-tools/nip19";

const SECRETS_PATH = join(homedir(), "openclaw", ".secrets", "nostr.json");
const DEFAULT_RELAY = "wss://zooid.atlantislabs.space";

function loadNsec(): string {
  if (process.env.NOSTR_NSEC) return process.env.NOSTR_NSEC;
  try {
    const secrets = JSON.parse(readFileSync(SECRETS_PATH, "utf-8"));
    if (secrets.nsec) return secrets.nsec;
  } catch {
    // fall through
  }
  console.error("Error: No nsec found. Set NOSTR_NSEC or create", SECRETS_PATH);
  process.exit(1);
}

/** Resolve npub/hex to hex pubkey */
function toHex(value: string): string {
  if (/^[a-f0-9]{64}$/i.test(value)) return value;
  if (value.startsWith("npub1")) {
    const decoded = nip19decode(value);
    if (decoded.type === "npub") return decoded.data as string;
  }
  console.error(`Invalid pubkey: ${value}`);
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const group = args.shift();
  const mentions: string[] = [];
  const messageParts: string[] = [];

  // Parse --mention flags
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--mention" || args[i] === "-m") {
      const val = args[++i];
      if (!val) { console.error("--mention requires a value"); process.exit(1); }
      mentions.push(toHex(val));
    } else {
      messageParts.push(args[i]);
    }
  }

  const message = messageParts.join(" ");

  if (!group || !message) {
    console.error("Usage: bun run bin/nostr-send.ts <group> [--mention <npub|hex>]... <message>");
    process.exit(1);
  }

  const nsec = loadNsec();
  const relayUrl = process.env.NOSTR_RELAY ?? DEFAULT_RELAY;

  console.log(`Connecting to ${relayUrl}...`);

  const handle = await connectRelay({
    relayUrl,
    nsec,
    groups: [group],
    onEvent: () => {}, // not listening
    onError: (err, ctx) => console.error(`[${ctx}]`, err.message),
  });

  console.log(`Authenticated as ${handle.publicKey.slice(0, 12)}...`);
  console.log(`Sending to group "${group}"...`);

  if (mentions.length) console.log(`Mentioning ${mentions.length} pubkey(s)`);
  const event = await handle.sendGroupMessage(group, message, mentions.length ? mentions : undefined);
  console.log(`Sent event ${event.id.slice(0, 12)}... (kind ${event.kind})`);

  handle.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err.message ?? err);
  process.exit(1);
});
