/**
 * Shared types for the NIP-29 Nostr channel plugin.
 */

/** A single NIP-29 group subscription entry. */
export interface GroupConfig {
  id: string;
  mentionOnly?: boolean;
}

/** Raw config block from channels.nostr-nip29 in the OpenClaw config. */
export interface NostrNip29Config {
  enabled?: boolean;
  privateKey: string;
  name?: string;
  relay: string;
  groups: GroupConfig[];
  groupAllowFrom?: string[];
  groupRequireMention?: boolean;
}

/** Resolved account object with defaults applied, used by the plugin at runtime. */
export interface NostrNip29Account {
  accountId: string;
  name: string;
  enabled: boolean;
  configured: boolean;
  publicKey: string | null;
  privateKey: string;
  relay: string;
  groups: GroupConfig[];
  groupAllowFrom: string[];
  groupRequireMention: boolean;
}
