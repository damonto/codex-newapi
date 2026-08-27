import { bounded, errorMessage, type LogFields } from "./log.ts";

export const MAX_LOGGED_UPSTREAM_ERROR_BYTES = 32 * 1024;
export const UPSTREAM_ERROR_LOG_TIMEOUT_MS = 750;

type ErrorBodyReadResult =
  | { bytes: Uint8Array }
  | { reason: "body_too_large" | "timeout" | "read_failed"; error?: string };

function declaredLength(value: string | null): bigint | undefined {
  const normalized = value?.trim();
  if (!normalized || !/^\d+$/.test(normalized)) {
    return undefined;
  }
  return BigInt(normalized);
}

function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  if (!body) {
    return;
  }
  try {
    void body.cancel().catch(() => {});
  } catch {
    // The clone may already be closed or errored. The original response is unaffected.
  }
}

async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  timeoutMs: number,
  contentLength: string | null,
): Promise<ErrorBodyReadResult> {
  const expectedLength = declaredLength(contentLength);
  if (expectedLength !== undefined && expectedLength > BigInt(maxBytes)) {
    cancelBody(body);
    return { reason: "body_too_large" };
  }
  if (!body) {
    return { bytes: new Uint8Array(0) };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const deadline = Date.now() + timeoutMs;
  const timeoutMarker = Symbol("upstream-error-log-timeout");
  let releaseDeferred = false;
  const cancelReader = (): void => {
    try {
      releaseDeferred = true;
      void reader
        .cancel()
        .catch(() => {})
        .finally(() => {
          try {
            reader.releaseLock();
          } catch {
            // The lock may already have been released after a synchronous cancellation failure.
          }
        });
    } catch {
      releaseDeferred = false;
    }
  };
  try {
    while (true) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        cancelReader();
        return { reason: "timeout" };
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      let result: ReadableStreamReadResult<Uint8Array> | typeof timeoutMarker;
      try {
        result = await Promise.race([
          reader.read(),
          new Promise<typeof timeoutMarker>((resolve) => {
            timer = setTimeout(() => resolve(timeoutMarker), remainingMs);
          }),
        ]);
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
      if (result === timeoutMarker) {
        cancelReader();
        return { reason: "timeout" };
      }
      if (result.done) {
        const bytes = new Uint8Array(totalBytes);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return { bytes };
      }
      totalBytes += result.value.byteLength;
      if (totalBytes > maxBytes) {
        cancelReader();
        return { reason: "body_too_large" };
      }
      chunks.push(result.value);
    }
  } catch (error) {
    return { reason: "read_failed", error: errorMessage(error) };
  } finally {
    if (!releaseDeferred) {
      reader.releaseLock();
    }
  }
}

function isJsonContentType(contentType: string | null): boolean {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return (
    mediaType === "application/json" || mediaType?.endsWith("+json") === true
  );
}

export function hasJsonUpstreamError(response: Response): boolean {
  return (
    !response.ok && isJsonContentType(response.headers.get("content-type"))
  );
}

function responseRequestId(response: Response): string | undefined {
  for (const header of ["x-request-id", "request-id", "x-correlation-id"]) {
    const value = response.headers.get(header);
    if (value) {
      return bounded(value, 256);
    }
  }
  return undefined;
}

export function upstreamResponseFields(response: Response): LogFields {
  const contentType = response.headers.get("content-type");
  const requestId = responseRequestId(response);
  return {
    status: response.status,
    ...(response.statusText
      ? { status_text: bounded(response.statusText, 128) }
      : {}),
    ...(contentType ? { content_type: bounded(contentType, 128) } : {}),
    ...(requestId ? { upstream_request_id: requestId } : {}),
  };
}

export function upstreamErrorStatusFields(response: Response): LogFields {
  return { status: response.status };
}

export async function upstreamResponseLogFields(
  response: Response,
  preserveResponse = true,
): Promise<LogFields> {
  if (response.ok) {
    return upstreamResponseFields(response);
  }
  const fields = upstreamErrorStatusFields(response);
  if (!hasJsonUpstreamError(response)) {
    return fields;
  }

  let source = response;
  if (preserveResponse) {
    try {
      source = response.clone();
    } catch (error) {
      return {
        ...fields,
        error_json_omitted: "clone_failed",
        error_body_read_error: errorMessage(error),
      };
    }
  }

  const result = await readBoundedBody(
    source.body,
    MAX_LOGGED_UPSTREAM_ERROR_BYTES,
    UPSTREAM_ERROR_LOG_TIMEOUT_MS,
    source.headers.get("content-length"),
  );
  const requestId = responseRequestId(response);
  const jsonFields = {
    ...fields,
    ...(requestId ? { upstream_request_id: requestId } : {}),
  };
  if (!("bytes" in result)) {
    return {
      ...jsonFields,
      error_json_omitted: result.reason,
      ...(result.error ? { error_body_read_error: result.error } : {}),
      error_body_limit_bytes: MAX_LOGGED_UPSTREAM_ERROR_BYTES,
    };
  }
  if (result.bytes.byteLength === 0) {
    return {
      ...jsonFields,
      error_json_omitted: "empty_body",
    };
  }

  try {
    return {
      ...jsonFields,
      error_body_bytes: result.bytes.byteLength,
      error_json: JSON.parse(new TextDecoder().decode(result.bytes)) as unknown,
    };
  } catch {
    return {
      ...jsonFields,
      error_body_bytes: result.bytes.byteLength,
      error_json_omitted: "invalid_json",
    };
  }
}
