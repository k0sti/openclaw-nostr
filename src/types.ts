/**
 * Shared types for the NIP-29 Nostr channel plugin.
 */

export interface GroupConfig {
  id: string;
  mentionOnly?: boolean;
}

export interface NostrNip29Config {
  enabled?: boolean;
  privateKey: string;
  name?: string;
  relay: string;
  groups: GroupConfig[];
  groupAllowFrom?: string[];
  groupRequireMention?: boolean;
}

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
