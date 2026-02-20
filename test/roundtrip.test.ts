/**
 * Roundtrip test: send a message to techteam with a second keypair,
 * verify the bot's relay handle receives it and mention detection works.
 */
import { describe, test, expect } from "bun:test";
import { connectRelay, decodeNsec } from "../src/relay";
import { checkMention } from "../src/mentions";
import { getPublicKey, generateSecretKey, finalizeEvent } from "nostr-tools/pure";
import { Relay } from "nostr-tools/relay";
import { npubEncode } from "nostr-tools/nip19";

const RELAY_URL = "wss://zooid.atlantislabs.space";
const NSEC = "nsec1536kja454h2shw3ztx6evvrkz29n2t24p28r8m7l2lhm9j5uy2wq6040j7";
const BOT_SK = decodeNsec(NSEC);
const BOT_PK = getPublicKey(BOT_SK);
const BOT_NAME = "clarity";
const GROUP = "techteam";

/** Connect a second keypair to zooid with AUTH */
async function connectSender(): Promise<{
  relay: Relay;
  sk: Uint8Array;
  pk: string;
}> {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const relay = await Relay.connect(RELAY_URL);

  const origAuth = relay.auth.bind(relay);
  relay.auth = async (_signer?: any) =>
    origAuth(async (evt: any) => finalizeEvent(evt, sk));

  if (relay.challenge) {
    try { await relay.auth(); } catch {}
  }
  relay.onauth = async () => {
    try { await relay.auth(); } catch {}
  };

  await new Promise((r) => setTimeout(r, 2000));
  return { relay, sk, pk };
}

describe("roundtrip", () => {
  test("send message with mention, bot receives and detects it", async () => {
    const received: Array<{ event: any; groupId: string }> = [];
    let eose = false;

    // 1. Bot connects and subscribes
    const bot = await connectRelay({
      relayUrl: RELAY_URL,
      nsec: NSEC,
      groups: [GROUP],
      since: Math.floor(Date.now() / 1000),
      onEvent: (event, groupId) => received.push({ event, groupId }),
      onEose: () => { eose = true; },
    });

    // Wait for EOSE before sending
    await new Promise((r) => setTimeout(r, 3000));
    expect(eose).toBe(true);

    // 2. Sender connects and sends a mention
    const sender = await connectSender();
    const npub = npubEncode(BOT_PK);
    const testText = `roundtrip-test-${Date.now()} nostr:${npub}`;

    const sendEvent = finalizeEvent(
      {
        kind: 9,
        content: testText,
        tags: [["h", GROUP], ["p", BOT_PK]],
        created_at: Math.floor(Date.now() / 1000),
      },
      sender.sk,
    );
    await sender.relay.publish(sendEvent);

    // 3. Wait for bot to receive the event
    await new Promise((r) => setTimeout(r, 3000));

    // 4. Check bot received it
    const match = received.find(
      (r) => r.event.content === testText && r.event.pubkey === sender.pk,
    );
    expect(match).toBeDefined();
    expect(match!.groupId).toBe(GROUP);

    // 5. Verify mention detection
    const mention = checkMention({
      tags: match!.event.tags,
      text: match!.event.content,
      botPubkey: BOT_PK,
      botName: BOT_NAME,
    });
    expect(mention.mentioned).toBe(true);
    expect(mention.pTag).toBe(true);
    expect(mention.textBech32).toBe(false); // textHex skips bech32 check? No — npub is bech32
    // Actually textHex is false (npub is bech32, not hex), so textBech32 should be true
    expect(mention.textBech32).toBe(true);

    // 6. Test bot can reply
    const reply = await bot.sendGroupMessage(GROUP, `roundtrip-reply-${Date.now()}`);
    expect(reply.kind).toBe(9);
    expect(reply.tags.find((t) => t[0] === "h")?.[1]).toBe(GROUP);

    // Cleanup
    bot.close();
    sender.relay.close();
  }, 30000);
});
