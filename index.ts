/**
 * OpenClaw NIP-29 Nostr plugin entry point.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { nostrNip29Plugin } from "./src/plugin.js";

const plugin = {
  id: "nostr-nip29",
  name: "Nostr NIP-29",
  description: "NIP-29 group chat channel for Nostr relays",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerChannel({ plugin: nostrNip29Plugin });
  },
};

export default plugin;
