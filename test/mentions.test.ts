/**
 * Unit tests for mention detection — all paths.
 */
import { describe, test, expect } from "bun:test";
import { checkMention } from "../src/mentions";
import { getPublicKey } from "nostr-tools/pure";
import { decode as nip19decode, npubEncode, nprofileEncode } from "nostr-tools/nip19";

const NSEC = "nsec1536kja454h2shw3ztx6evvrkz29n2t24p28r8m7l2lhm9j5uy2wq6040j7";
const { data: SK } = nip19decode(NSEC) as { data: Uint8Array };
const BOT_PUBKEY = getPublicKey(SK);
const BOT_NAME = "clarity";

describe("mentions", () => {
  test("p-tag mention", () => {
    const result = checkMention({
      tags: [["h", "techteam"], ["p", BOT_PUBKEY]],
      text: "hello everyone",
      botPubkey: BOT_PUBKEY,
      botName: BOT_NAME,
    });
    expect(result.mentioned).toBe(true);
    expect(result.pTag).toBe(true);
    expect(result.textHex).toBe(false);
    expect(result.textBech32).toBe(false);
    expect(result.name).toBe(false);
  });

  test("hex pubkey in text", () => {
    const result = checkMention({
      tags: [["h", "techteam"]],
      text: `hey ${BOT_PUBKEY} what do you think?`,
      botPubkey: BOT_PUBKEY,
      botName: BOT_NAME,
    });
    expect(result.mentioned).toBe(true);
    expect(result.pTag).toBe(false);
    expect(result.textHex).toBe(true);
  });

  test("npub in text", () => {
    const npub = npubEncode(BOT_PUBKEY);
    const result = checkMention({
      tags: [["h", "techteam"]],
      text: `hey nostr:${npub} check this`,
      botPubkey: BOT_PUBKEY,
      botName: BOT_NAME,
    });
    expect(result.mentioned).toBe(true);
    expect(result.textBech32).toBe(true);
    expect(result.textHex).toBe(false);
  });

  test("nprofile in text", () => {
    const nprofile = nprofileEncode({ pubkey: BOT_PUBKEY, relays: [] });
    const result = checkMention({
      tags: [["h", "techteam"]],
      text: `nostr:${nprofile} thoughts?`,
      botPubkey: BOT_PUBKEY,
      botName: BOT_NAME,
    });
    expect(result.mentioned).toBe(true);
    expect(result.textBech32).toBe(true);
  });

  test("name mention (case-insensitive)", () => {
    const result = checkMention({
      tags: [["h", "techteam"]],
      text: "Hey Clarity, what do you think?",
      botPubkey: BOT_PUBKEY,
      botName: BOT_NAME,
    });
    expect(result.mentioned).toBe(true);
    expect(result.name).toBe(true);
    expect(result.pTag).toBe(false);
    expect(result.textHex).toBe(false);
    expect(result.textBech32).toBe(false);
  });

  test("no mention at all", () => {
    const result = checkMention({
      tags: [["h", "techteam"]],
      text: "just chatting about random stuff",
      botPubkey: BOT_PUBKEY,
      botName: BOT_NAME,
    });
    expect(result.mentioned).toBe(false);
    expect(result.pTag).toBe(false);
    expect(result.textHex).toBe(false);
    expect(result.textBech32).toBe(false);
    expect(result.name).toBe(false);
  });

  test("no botName skips name check", () => {
    const result = checkMention({
      tags: [["h", "techteam"]],
      text: "Hey Clarity, what do you think?",
      botPubkey: BOT_PUBKEY,
      // no botName
    });
    expect(result.name).toBe(false);
    expect(result.mentioned).toBe(false);
  });

  test("invalid nostr: URI is ignored", () => {
    const result = checkMention({
      tags: [],
      text: "nostr:npub1invaliddata here",
      botPubkey: BOT_PUBKEY,
      botName: BOT_NAME,
    });
    // Should not crash, just no bech32 match
    expect(result.textBech32).toBe(false);
  });

  test("multiple mentions — first match wins", () => {
    const npub = npubEncode(BOT_PUBKEY);
    const result = checkMention({
      tags: [["p", BOT_PUBKEY]],
      text: `nostr:${npub} hey ${BOT_PUBKEY} clarity`,
      botPubkey: BOT_PUBKEY,
      botName: BOT_NAME,
    });
    expect(result.mentioned).toBe(true);
    expect(result.pTag).toBe(true);
    // textHex is true because the hex pubkey IS in the text
    expect(result.textHex).toBe(true);
    // textBech32 is skipped when textHex is true (optimization)
    expect(result.textBech32).toBe(false);
    expect(result.name).toBe(true);
  });
});
