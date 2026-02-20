/**
 * Config schema + account resolution for NIP-29 Nostr channel plugin.
 */
import { getPublicKey } from "nostr-tools/pure";
import { decodeNsec } from "./relay.js";
import type { NostrNip29Account, NostrNip29Config } from "./types.js";

const DEFAULT_ACCOUNT_ID = "default";

/** Extract the nostr-nip29 config block from the OpenClaw config */
function getChannelConfig(cfg: Record<string, any>): Partial<NostrNip29Config> {
  const channels = (cfg?.channels ?? {}) as Record<string, any>;
  return (channels["nostr-nip29"] ?? {}) as Partial<NostrNip29Config>;
}

/** List all account IDs (we only support a single "default" account) */
export function listAccountIds(_cfg: Record<string, any>): string[] {
  return [DEFAULT_ACCOUNT_ID];
}

/** Resolve account config into a typed object */
export function resolveAccount(
  cfg: Record<string, any>,
  accountId?: string | null,
): NostrNip29Account {
  const id = accountId ?? DEFAULT_ACCOUNT_ID;
  const raw = getChannelConfig(cfg);

  let publicKey: string | null = null;
  let secretKeyValid = false;
  if (raw.privateKey) {
    try {
      const sk = decodeNsec(raw.privateKey);
      publicKey = getPublicKey(sk);
      secretKeyValid = true;
    } catch {
      // invalid key — account not configured
    }
  }

  return {
    accountId: id,
    name: raw.name ?? "nostr-nip29",
    enabled: raw.enabled !== false,
    configured: secretKeyValid && !!raw.relay,
    publicKey,
    privateKey: raw.privateKey ?? "",
    relay: raw.relay ?? "",
    groups: raw.groups ?? [],
    groupAllowFrom: raw.groupAllowFrom ?? ["*"],
    groupRequireMention: raw.groupRequireMention ?? true,
  };
}
