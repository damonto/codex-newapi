export type ApiProtocol = "openai" | "anthropic";

function isAnthropicPath(pathname: string): boolean {
  // Claude Code's SDK uses these inference endpoints. Keep the prefix rule
  // so future /v1/messages/* endpoints (for example batches) are recognized
  // without a separate entry here.
  return pathname === "/v1/messages" || pathname.startsWith("/v1/messages/");
}

export function requestProtocol(request: Request): ApiProtocol {
  if (request.headers.has("anthropic-version")) {
    return "anthropic";
  }
  return isAnthropicPath(new URL(request.url).pathname)
    ? "anthropic"
    : "openai";
}

export function isAnthropicProtocol(protocol: ApiProtocol): boolean {
  return protocol === "anthropic";
}
