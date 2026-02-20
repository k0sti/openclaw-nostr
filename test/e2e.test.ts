import { describe, test, expect } from "bun:test";
import { connectRelay, type RelayHandle } from "../src/relay";
import { checkMention } from "../src/mentions";
import { exec } from "child_process";
import { promisify } from "util";
import type { Event } from "nostr-tools/pure";

const execAsync = promisify(exec);

const BOT_NSEC = "nsec1536kja454h2shw3ztx6evvrkz29n2t24p28r8m7l2lhm9j5uy2wq6040j7";
const RELAY = "wss://zooid.atlantislabs.space";
const GROUP = "techteam";
const TEST_TOKEN = `e2e_${Date.now()}`;

describe("e2e", () => {
  test("bot receives mention from k0 and detects it", async () => {
    const received: Array<{ event: Event; groupId: string }> = [];
    let resolveGot: () => void;
    const gotMessage = new Promise<void>((r) => { resolveGot = r; });

    // 1. Connect bot
    const handle = await connectRelay({
      relayUrl: RELAY,
      nsec: BOT_NSEC,
      groups: [GROUP],
      onEvent: (event, groupId) => {
        if (event.content.includes(TEST_TOKEN)) {
          received.push({ event, groupId });
          resolveGot();
        }
      },
      onError: (err, ctx) => console.error(`Relay error (${ctx}):`, err.message),
    });

    expect(handle.publicKey).toBeTruthy();

    // 2. Wait for subscription to settle
    await new Promise((r) => setTimeout(r, 1000));

    // 3. Send mention as k0 via nostr-post.ts
    // Clarity's actual npub
    const npub = "nostr:npub162070sd0z702cyrk0at6cqsl2g95f2x7687n0vw377wfu4zljmts6fm8aw";
    const mentionText = `${npub} ${TEST_TOKEN} testing e2e`;
    await execAsync(
      `bun run /home/k0/work/nostronautti/bridge.old/nostr-post.ts techteam "${mentionText}"`
    );

    // 4. Wait for message (10s timeout)
    await Promise.race([
      gotMessage,
      new Promise<void>((_, rej) => setTimeout(() => rej(new Error("Timeout waiting for message")), 10000)),
    ]);

    // 5. Verify receipt
    expect(received.length).toBeGreaterThan(0);
    const { event } = received[0];
    expect(event.content).toContain(TEST_TOKEN);

    // 6. Verify mention detection
    const { mentioned } = checkMention({ text: event.content, tags: event.tags, botPubkey: handle.publicKey, botName: "clarity" });
    expect(mentioned).toBe(true);

    handle.close();
  }, 20000);

  test("bot can publish reply to group", async () => {
    let resolveGot: (text: string) => void;
    const gotReply = new Promise<string>((r) => { resolveGot = r; });
    const replyToken = `reply_${Date.now()}`;

    const handle = await connectRelay({
      relayUrl: RELAY,
      nsec: BOT_NSEC,
      groups: [GROUP],
      since: 0, // include recent to catch our own message
      onEvent: (event) => {
        if (event.content.includes(replyToken) && event.pubkey === handle.publicKey) {
          resolveGot(event.content);
        }
      },
      onError: (err, ctx) => console.error(`Relay error (${ctx}):`, err.message),
    });

    // Wait for sub to settle
    await new Promise((r) => setTimeout(r, 1000));

    // Publish
    const sent = await handle.sendGroupMessage(GROUP, `Bot reply ${replyToken}`);
    expect(sent.kind).toBe(9);
    expect(sent.tags).toContainEqual(["h", GROUP]);

    // Verify we receive our own message back (relay echoes)
    const result = await Promise.race([
      gotReply,
      new Promise<string>((_, rej) => setTimeout(() => rej(new Error("Timeout")), 10000)),
    ]);
    expect(result).toContain(replyToken);

    handle.close();
  }, 20000);
});
