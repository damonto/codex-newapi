import type { GatewayConfig } from "./types.ts";

const upstreamApiKeysByConfig = new WeakMap<GatewayConfig, readonly string[]>();

export function upstreamApiKeyValues(
  config: GatewayConfig,
): readonly string[] {
  const cached = upstreamApiKeysByConfig.get(config);
  if (cached) {
    return cached;
  }
  const values = config.services.flatMap((service) =>
    service.keys.map((key) => key.api_key)
  );
  upstreamApiKeysByConfig.set(config, values);
  return values;
}
