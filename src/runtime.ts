/**
 * Stores the PluginRuntime reference from the plugin API.
 *
 * External plugins must use api.runtime (PluginRuntime) — not
 * ctx.runtime (RuntimeEnv) from the gateway context — to call
 * handleInboundMessage.  The PluginRuntime carries the full
 * channel-reply dispatch layer that routes agent replies back
 * through the correct outbound adapter.
 */

// Using `any` because PluginRuntime is an opaque type from openclaw internals.
// The bundled nostr plugin does the same pattern.
let _runtime: any = null;

export function setPluginRuntime(runtime: any): void {
  _runtime = runtime;
}

export function getPluginRuntime(): any {
  if (!_runtime) {
    throw new Error(
      "NIP-29 plugin runtime not initialized — setPluginRuntime() must be called in register()",
    );
  }
  return _runtime;
}
