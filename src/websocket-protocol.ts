import { BodyTooLargeError, readBodyWithinLimit } from "./body.ts";
const MAX_UPSTREAM_ERROR_BYTES = 32 * 1024;
const MAX_CLOSE_REASON_BYTES = 123;

export type JsonObject = Record<string, unknown>;
export type WebSocketMessage = string | ArrayBuffer | ArrayBufferView;

export interface ResponseCreateFrame {
  payload: JsonObject;
  model: string;
  sessionId?: string;
}

export type ClientFrame =
  | { kind: "other" }
  | { kind: "invalid_response_create" }
  | { kind: "response_create"; frame: ResponseCreateFrame };

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export function parseObject(text: string): JsonObject | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as JsonObject
      : undefined;
  } catch {
    return undefined;
  }
}

export function clientFrame(text: string): ClientFrame {
  const payload = parseObject(text);
  if (!payload || payload.type !== "response.create") {
    return { kind: "other" };
  }
  const model = nonEmptyString(payload.model);
  if (!model) {
    return { kind: "invalid_response_create" };
  }
  const metadata = payload.client_metadata;
  const sessionId = typeof metadata === "object" &&
      metadata !== null &&
      !Array.isArray(metadata)
    ? nonEmptyString((metadata as JsonObject).session_id)
    : undefined;
  return {
    kind: "response_create",
    frame: { payload, model, sessionId },
  };
}

export function rewriteResponseCreate(
  original: string,
  frame: ResponseCreateFrame,
  upstreamModel: string,
): string {
  return frame.model === upstreamModel
    ? original
    : JSON.stringify({ ...frame.payload, model: upstreamModel });
}

export function messageBytes(value: unknown): number {
  if (typeof value === "string") {
    return new TextEncoder().encode(value).byteLength;
  }
  if (value instanceof ArrayBuffer) {
    return value.byteLength;
  }
  if (ArrayBuffer.isView(value)) {
    return value.byteLength;
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return value.size;
  }
  return 0;
}

export async function normalizeMessage(
  value: unknown,
): Promise<WebSocketMessage | undefined> {
  if (typeof value === "string" || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return value;
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return value.arrayBuffer();
  }
  return undefined;
}

export function safeSend(
  socket: WebSocket | undefined,
  message: WebSocketMessage,
): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  try {
    socket.send(message);
    return true;
  } catch {
    return false;
  }
}

function normalizedCloseCode(code: number): number {
  return code >= 1000 &&
      code <= 4999 &&
      code !== 1004 &&
      code !== 1005 &&
      code !== 1006 &&
      code !== 1015
    ? code
    : 1011;
}

export function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) {
    return value;
  }
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength;
    if (bytes + characterBytes > maxBytes) {
      break;
    }
    result += character;
    bytes += characterBytes;
  }
  return result;
}

export function closeSocket(socket: WebSocket | undefined, code: number, reason: string): void {
  if (!socket || socket.readyState === WebSocket.CLOSED) {
    return;
  }
  try {
    if (code === 1005) {
      socket.close();
      return;
    }
    socket.close(
      normalizedCloseCode(code),
      truncateUtf8(reason, MAX_CLOSE_REASON_BYTES),
    );
  } catch {
    // The peer may already have completed the close handshake.
  }
}

export function errorStatus(value: JsonObject): number | undefined {
  const numericStatus = (candidate: unknown): number | undefined => {
    if (typeof candidate === "number" && Number.isInteger(candidate)) {
      return candidate;
    }
    if (typeof candidate === "string" && /^\d{3}$/.test(candidate)) {
      return Number(candidate);
    }
    return undefined;
  };
  const direct = numericStatus(value.status) ?? numericStatus(value.status_code);
  if (direct !== undefined) {
    return direct;
  }
  const nested = value.error;
  if (typeof nested === "object" && nested !== null && !Array.isArray(nested)) {
    const error = nested as JsonObject;
    const status = numericStatus(error.status) ??
      numericStatus(error.status_code) ??
      numericStatus(error.http_status);
    if (status !== undefined) {
      return status;
    }
  }
  const response = value.response;
  if (typeof response === "object" && response !== null && !Array.isArray(response)) {
    const responseObject = response as JsonObject;
    const status = numericStatus(responseObject.status_code) ??
      numericStatus(responseObject.http_status);
    if (status !== undefined) {
      return status;
    }
    const responseError = responseObject.error;
    if (
      typeof responseError === "object" &&
      responseError !== null &&
      !Array.isArray(responseError)
    ) {
      const error = responseError as JsonObject;
      return numericStatus(error.status) ??
        numericStatus(error.status_code) ??
        numericStatus(error.http_status);
    }
  }
  return undefined;
}

export async function upstreamErrorText(response: Response): Promise<string | undefined> {
  if (!response.body) {
    return undefined;
  }
  try {
    const body = await readBodyWithinLimit(
      response.body,
      MAX_UPSTREAM_ERROR_BYTES,
      response.headers.get("content-length"),
    );
    const text = new TextDecoder().decode(body);
    return text === "" ? undefined : text;
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return undefined;
    }
    throw error;
  }
}

export function gatewayErrorEvent(status: number, message: string, code: string): string {
  return JSON.stringify({
    type: "error",
    status,
    error: {
      message,
      type: status >= 500 ? "server_error" : "invalid_request_error",
      code,
    },
  });
}
