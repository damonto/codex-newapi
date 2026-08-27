export class BodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`body exceeds the ${maxBytes}-byte limit`);
    this.name = "BodyTooLargeError";
  }
}

async function cancelBody(
  body: ReadableStream<Uint8Array> | null,
): Promise<void> {
  if (!body) {
    return;
  }
  try {
    await body.cancel();
  } catch {
    // The stream may already be errored or locked. There is nothing else to consume.
  }
}

function declaredLength(
  contentLength: string | null | undefined,
): bigint | undefined {
  const normalized = contentLength?.trim();
  if (!normalized || !/^\d+$/.test(normalized)) {
    return undefined;
  }
  return BigInt(normalized);
}

export async function readBodyWithinLimit(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  contentLength?: string | null,
  onChunk?: (byteLength: number) => void,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer");
  }
  const expectedLength = declaredLength(contentLength);
  if (expectedLength !== undefined && expectedLength > BigInt(maxBytes)) {
    await cancelBody(body);
    throw new BodyTooLargeError(maxBytes);
  }
  if (!body) {
    return new Uint8Array(0);
  }

  const reader = body.getReader();
  const initialCapacity =
    expectedLength === undefined
      ? Math.min(maxBytes, 64 * 1024)
      : Number(expectedLength);
  let buffer = new Uint8Array(initialCapacity);
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const requiredBytes = totalBytes + value.byteLength;
      if (requiredBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The limit error below is the actionable failure for the caller.
        }
        throw new BodyTooLargeError(maxBytes);
      }
      onChunk?.(value.byteLength);
      if (requiredBytes > buffer.byteLength) {
        const doubledCapacity = Math.max(1, buffer.byteLength * 2);
        const nextCapacity = Math.min(
          maxBytes,
          Math.max(requiredBytes, doubledCapacity),
        );
        const grown = new Uint8Array(nextCapacity);
        grown.set(buffer.subarray(0, totalBytes));
        buffer = grown;
      }
      buffer.set(value, totalBytes);
      totalBytes = requiredBytes;
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Preserve the original read or limit error.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
  return buffer.subarray(0, totalBytes);
}

export async function discardBody(
  body: ReadableStream<Uint8Array> | null,
): Promise<void> {
  await cancelBody(body);
}
