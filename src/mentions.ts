/**
 * Mention detection for NIP-29 group messages.
 * Checks: p-tags, hex pubkey in text, nostr:nprofile/npub URIs, bot name.
 * Proven pattern from test-mention.ts.
 */
import { decode as nip19decode } from "nostr-tools/nip19";

/** Input parameters for mention detection. */
export interface MentionCheckParams {
  /** Event tags */
  tags: string[][];
  /** Event content text */
  text: string;
  /** Bot's hex pubkey */
  botPubkey: string;
  /** Bot's display name (optional fallback) */
  botName?: string;
}

/** Result of mention detection, with flags for each detection method. */
export interface MentionResult {
  mentioned: boolean;
  pTag: boolean;
  textHex: boolean;
  textBech32: boolean;
  name: boolean;
}

const NOSTR_URI_REGEX = /nostr:(nprofile|npub)1[a-z0-9]+/gi;

/** Check if an event mentions the bot */
export function checkMention(params: MentionCheckParams): MentionResult {
  const { tags, text, botPubkey, botName } = params;

  // 1. p-tag check
  const pTag = tags.some((t) => t[0] === "p" && t[1] === botPubkey);

  // 2. hex pubkey in text
  const textHex = text.includes(botPubkey);

  // 3. bech32 decode (nprofile / npub)
  let textBech32 = false;
  if (!textHex) {
    const uris = text.match(NOSTR_URI_REGEX);
    if (uris) {
      for (const uri of uris) {
        const bech32 = uri.replace(/^nostr:/i, "");
        try {
          const decoded = nip19decode(bech32);
          const decodedPubkey =
            decoded.type === "npub"
              ? (decoded.data as string)
              : decoded.type === "nprofile"
                ? (decoded.data as { pubkey: string }).pubkey
                : null;
          if (decodedPubkey === botPubkey) {
            textBech32 = true;
            break;
          }
        } catch {
          // ignore decode errors
        }
      }
    }
  }

  // 4. name check (case-insensitive)
  const name = botName ? text.toLowerCase().includes(botName.toLowerCase()) : false;

  return {
    mentioned: pTag || textHex || textBech32 || name,
    pTag,
    textHex,
    textBech32,
    name,
  };
}
