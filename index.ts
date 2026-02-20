/**
 * OpenClaw NIP-29 Nostr plugin entry point.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { nostrNip29Plugin } from "./src/plugin.js";
import { setPluginRuntime } from "./src/runtime.js";

const plugin = {
  id: "nostr-nip29",
  name: "Nostr NIP-29",
  description: "NIP-29 group chat channel for Nostr relays",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    // Store api.runtime (PluginRuntime) so the gateway can use it for
    // handleInboundMessage — ctx.runtime (RuntimeEnv) lacks the full
    // channel-reply dispatch layer needed for outbound routing.
    setPluginRuntime(api.runtime);
    api.registerChannel({ plugin: nostrNip29Plugin });
  },
};

export default plugin;
