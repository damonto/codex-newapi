export type ApiProtocol = "openai" | "anthropic";

/** Inference paths the gateway forwards, relative to a service's base URL. */
export type InferencePath =
  | "responses"
  | "responses/compact"
  | "alpha/search"
  | "chat/completions"
  | "images/generations"
  | "images/edits"
  | "messages"
  | "messages/count_tokens";

/** Every endpoint the gateway routes, including the non-inference ones. */
export type GatewayEndpoint = "models" | "health" | "sessions" | InferencePath;

// The dialect each endpoint is defined in. `undefined` marks the endpoints that
// belong to neither dialect, where the client's own identity decides.
const ENDPOINT_PROTOCOLS: Record<GatewayEndpoint, ApiProtocol | undefined> = {
  messages: "anthropic",
  "messages/count_tokens": "anthropic",
  responses: "openai",
  "responses/compact": "openai",
  "alpha/search": "openai",
  "chat/completions": "openai",
  "images/generations": "openai",
  "images/edits": "openai",
  models: undefined,
  health: undefined,
  sessions: undefined,
};

function isClaudeUserAgent(request: Request): boolean {
  return (
    request.headers.get("user-agent")?.toLowerCase().includes("claude") ?? false
  );
}

/**
 * Resolves the dialect a request is speaking. One upstream service may serve
 * either dialect, so this is always derived from the request and never declared
 * per service.
 *
 * Signals, strongest first:
 *   1. `anthropic-version`, which only Anthropic clients send.
 *   2. The endpoint's own dialect, since `/v1/messages` is Anthropic and
 *      `/v1/chat/completions` is OpenAI whatever the client calls itself.
 *   3. A Claude user agent, which decides only the dialect-neutral endpoints
 *      (`/v1/models`, `/health`, `/sessions`).
 */
export function requestProtocol(
  request: Request,
  endpoint?: GatewayEndpoint,
): ApiProtocol {
  if (request.headers.has("anthropic-version")) {
    return "anthropic";
  }
  const endpointProtocol =
    endpoint === undefined ? undefined : ENDPOINT_PROTOCOLS[endpoint];
  if (endpointProtocol !== undefined) {
    return endpointProtocol;
  }
  return isClaudeUserAgent(request) ? "anthropic" : "openai";
}

export function isAnthropicProtocol(protocol: ApiProtocol): boolean {
  return protocol === "anthropic";
}
