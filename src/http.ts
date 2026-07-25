import type { ClientApiKeyConfig, ServiceConfig } from "./types.ts";

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
  "x-real-ip",
  "x-client-ip",
  "true-client-ip",
  "content-length",
]);

export function shouldStripRequestHeader(name: string): boolean {
  const lowerName = name.toLowerCase();
  return HOP_BY_HOP_HEADERS.has(lowerName) ||
    SENSITIVE_REQUEST_HEADERS.has(lowerName) ||
    lowerName.startsWith("x-forwarded-") ||
    lowerName.startsWith("x-real-") ||
    lowerName.startsWith("x-envoy-") ||
    lowerName.startsWith("cf-") ||
    lowerName.startsWith("proxy-");
}

export function jsonResponse(value: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), { status, headers });
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

export function bearerToken(request: Request): string | undefined {
  const value = request.headers.get("authorization");
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1].trim() || undefined;
}

export function findClientApiKey(
  request: Request,
  entries: ClientApiKeyConfig[],
): ClientApiKeyConfig | undefined {
  const token = bearerToken(request);
  if (!token) {
    return undefined;
  }
  return entries.find((entry) => entry.api_key === token);
}

export function upstreamUrl(service: ServiceConfig, path: string, search = ""): string {
  const base = service.base_url.replace(/\/+$/, "");
  const suffix = path.replace(/^\/+/, "");
  return `${base}/${suffix}${search}`;
}

export function forwardRequestHeaders(request: Request, serviceApiKey: string): Headers {
  const headers = new Headers();
  request.headers.forEach((value, name) => {
    if (!shouldStripRequestHeader(name)) {
      headers.set(name, value);
    }
  });
  headers.set("authorization", `Bearer ${serviceApiKey}`);
  return headers;
}
