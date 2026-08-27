import type { ClientApiKeyConfig, ServiceConfig } from "./types.ts";
import {
  isAnthropicProtocol,
  requestProtocol,
  type ApiProtocol,
} from "./protocol.ts";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "expect",
  "via",
]);

const SENSITIVE_REQUEST_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "forwarded",
  "x-api-key",
  "x-api-token",
  "api-key",
  "x-auth-token",
  "x-access-token",
  "x-client-key",
  "x-openai-actor-authorization",
  "x-oai-attestation",
  "chatgpt-account-id",
  "x-real-ip",
  "x-client-ip",
  "true-client-ip",
  "content-length",
]);

export function shouldStripRequestHeader(name: string): boolean {
  const lowerName = name.toLowerCase();
  return (
    HOP_BY_HOP_HEADERS.has(lowerName) ||
    SENSITIVE_REQUEST_HEADERS.has(lowerName) ||
    lowerName.startsWith("x-cody-") ||
    lowerName.startsWith("x-forwarded-") ||
    lowerName.startsWith("x-real-") ||
    lowerName.startsWith("x-envoy-") ||
    lowerName.startsWith("cf-") ||
    lowerName.startsWith("proxy-")
  );
}

export function forwardableWebSocketHeaders(request: Request): Headers {
  const headers = new Headers();
  request.headers.forEach((value, name) => {
    if (
      !shouldStripRequestHeader(name) &&
      !name.toLowerCase().startsWith("sec-websocket-")
    ) {
      headers.set(name, value);
    }
  });
  return headers;
}

export function jsonResponse(
  value: unknown,
  status = 200,
  extraHeaders?: HeadersInit,
): Response {
  const headers = new Headers(extraHeaders);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), { status, headers });
}

export function anthropicError(
  status: number,
  message: string,
  type = "invalid_request_error",
): Response {
  return jsonResponse(
    {
      type: "error",
      error: {
        type,
        message,
      },
    },
    status,
  );
}

export function openAiError(
  status: number,
  message: string,
  type = "invalid_request_error",
  code?: string,
): Response {
  return jsonResponse(
    {
      error: {
        message,
        type,
        param: null,
        ...(code ? { code } : {}),
      },
    },
    status,
  );
}

export function apiError(
  protocol: ApiProtocol,
  status: number,
  message: string,
  type = "invalid_request_error",
  code?: string,
): Response {
  const normalizedType =
    isAnthropicProtocol(protocol) &&
    status === 401 &&
    type === "invalid_request_error"
      ? "authentication_error"
      : type;
  return isAnthropicProtocol(protocol)
    ? anthropicError(status, message, normalizedType)
    : openAiError(status, message, normalizedType, code);
}

export function bearerToken(request: Request): string | undefined {
  const value = request.headers.get("authorization");
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1].trim() || undefined;
}

export function requestCredentialTokens(request: Request): string[] {
  const tokens: string[] = [];
  const bearer = bearerToken(request);
  if (bearer) {
    tokens.push(bearer);
  }
  const apiKey = request.headers.get("x-api-key");
  if (apiKey && apiKey.trim() !== "") {
    tokens.push(apiKey.trim());
  }
  return tokens;
}

export function findClientApiKey(
  request: Request,
  entries: ClientApiKeyConfig[],
): Promise<ClientApiKeyConfig | undefined> {
  return findClientApiKeyByToken(requestCredentialTokens(request), entries);
}

async function digestSecret(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}

function hexDigest(value: ArrayBuffer): string {
  return [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function parseHexDigest(value: string): ArrayBuffer | undefined {
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    return undefined;
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes.buffer as ArrayBuffer;
}

export async function clientApiKeyDigest(value: string): Promise<string> {
  return hexDigest(await digestSecret(value));
}

interface TimingSafeSubtleCrypto extends SubtleCrypto {
  timingSafeEqual(
    left: ArrayBuffer | ArrayBufferView,
    right: ArrayBuffer | ArrayBufferView,
  ): boolean;
}

function hasTimingSafeEqual(
  value: SubtleCrypto,
): value is TimingSafeSubtleCrypto {
  return typeof Reflect.get(value, "timingSafeEqual") === "function";
}

function equalDigests(left: ArrayBuffer, right: ArrayBuffer): boolean {
  if (hasTimingSafeEqual(crypto.subtle)) {
    return crypto.subtle.timingSafeEqual(left, right);
  }

  // Node.js does not expose the Workers timingSafeEqual extension. Keep the
  // test/tooling fallback fixed-length and non-short-circuiting as well.
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  let difference = leftBytes.byteLength ^ rightBytes.byteLength;
  const length = Math.max(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

async function findClientApiKeyByToken(
  tokens: string[],
  entries: ClientApiKeyConfig[],
): Promise<ClientApiKeyConfig | undefined> {
  if (tokens.length === 0) {
    return undefined;
  }
  const providedDigests = await Promise.all(tokens.map(digestSecret));
  let matched: ClientApiKeyConfig | undefined;
  for (const entry of entries) {
    const expectedDigest = await digestSecret(entry.api_key);
    const digestMatches = providedDigests.some((providedDigest) =>
      equalDigests(providedDigest, expectedDigest),
    );
    if (digestMatches && matched === undefined) {
      matched = entry;
    }
  }
  return matched;
}

export async function findClientApiKeyByDigest(
  digest: string,
  entries: ClientApiKeyConfig[],
): Promise<ClientApiKeyConfig | undefined> {
  const providedDigest = parseHexDigest(digest);
  if (!providedDigest) {
    return undefined;
  }
  let matched: ClientApiKeyConfig | undefined;
  for (const entry of entries) {
    const expectedDigest = await digestSecret(entry.api_key);
    if (equalDigests(providedDigest, expectedDigest) && matched === undefined) {
      matched = entry;
    }
  }
  return matched;
}

export function upstreamUrl(
  service: ServiceConfig,
  path: string,
  search = "",
): string {
  const base = service.base_url.replace(/\/+$/, "");
  const suffix = path.replace(/^\/+/, "");
  return `${base}/${suffix}${search}`;
}

export function forwardRequestHeaders(
  request: Request,
  serviceApiKey: string,
): Headers {
  const headers = new Headers();
  request.headers.forEach((value, name) => {
    if (!shouldStripRequestHeader(name)) {
      headers.set(name, value);
    }
  });
  return forwardCredentialHeaders(
    headers,
    request,
    serviceApiKey,
    requestProtocol(request),
  );
}

function forwardCredentialHeaders(
  headers: Headers,
  request: Request,
  serviceApiKey: string,
  protocol: "openai" | "anthropic",
): Headers {
  if (protocol === "anthropic") {
    for (const name of ["authorization", "x-api-key"]) {
      if (request.headers.has(name)) {
        headers.set(
          name,
          name === "authorization" ? `Bearer ${serviceApiKey}` : serviceApiKey,
        );
      }
    }
    return headers;
  }
  headers.set("authorization", `Bearer ${serviceApiKey}`);
  return headers;
}

export function forwardWebSocketHeaders(
  request: Request,
  serviceApiKey: string,
): Headers {
  const headers = forwardableWebSocketHeaders(request);
  headers.set("authorization", `Bearer ${serviceApiKey}`);
  headers.set("upgrade", "websocket");
  return headers;
}
