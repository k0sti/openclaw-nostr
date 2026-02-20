/**
 * Integration test: connect to zooid relay, authenticate, subscribe, receive events.
 */
import { describe, test, expect } from "bun:test";
import { connectRelay, decodeNsec } from "../src/relay";
import { getPublicKey } from "nostr-tools/pure";

const RELAY = "wss://zooid.atlantislabs.space";
const NSEC = "nsec1536kja454h2shw3ztx6evvrkz29n2t24p28r8m7l2lhm9j5uy2wq6040j7";
const GROUP = "techteam";

describe("relay", () => {
  test("decodeNsec returns valid key", () => {
    const sk = decodeNsec(NSEC);
    expect(sk).toBeInstanceOf(Uint8Array);
    expect(sk.length).toBe(32);
    const pk = getPublicKey(sk);
    expect(pk).toMatch(/^[0-9a-f]{64}$/);
  });

  test("connect, auth, subscribe, receive EOSE", async () => {
    const events: Array<{ event: any; groupId: string }> = [];
    let gotEose = false;

    const handle = await connectRelay({
      relayUrl: RELAY,
      nsec: NSEC,
      groups: [GROUP],
      since: Math.floor(Date.now() / 1000) - 3600, // last hour
      onEvent: (event, groupId) => {
        events.push({ event, groupId });
      },
      onEose: () => {
        gotEose = true;
      },
    });

    expect(handle.relay.connected).toBe(true);
    expect(handle.publicKey).toMatch(/^[0-9a-f]{64}$/);

    // Wait for EOSE (relay sends stored events then EOSE)
    await new Promise((r) => setTimeout(r, 3000));

    expect(gotEose).toBe(true);

    // Events from last hour (may be 0 if no recent activity, that's OK)
    for (const e of events) {
      expect(e.groupId).toBe(GROUP);
      expect(e.event.kind).toBeOneOf([9, 11, 12]);
    }

    handle.close();
  }, 15000);
});
