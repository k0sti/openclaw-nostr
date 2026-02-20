#!/usr/bin/env bun
/**
 * Standalone CLI to send messages to Nostr NIP-29 groups.
 * Bypasses OpenClaw's cross-context restrictions by using exec/shell.
 *
 * Usage: bun run bin/nostr-send.ts <group> <message>
 * Env:   NOSTR_NSEC (or reads ~/openclaw/.secrets/nostr.json)
 *        NOSTR_RELAY (default: wss://zooid.atlantislabs.space)
 */
import { connectRelay } from "../src/relay.js";
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

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

async function main() {
  const [group, ...messageParts] = process.argv.slice(2);
  const message = messageParts.join(" ");

  if (!group || !message) {
    console.error("Usage: bun run bin/nostr-send.ts <group> <message>");
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

  const event = await handle.sendGroupMessage(group, message);
  console.log(`Sent event ${event.id.slice(0, 12)}... (kind ${event.kind})`);

  handle.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err.message ?? err);
  process.exit(1);
});
