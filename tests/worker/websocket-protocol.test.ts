import { expect, test, vi } from "vitest";

import { closeSocket, truncateUtf8 } from "../../src/websocket-protocol.ts";

function openSocketSpy(): {
  socket: WebSocket;
  close: ReturnType<typeof vi.fn>;
} {
  const close = vi.fn();
  const socket = {
    readyState: WebSocket.OPEN,
    close,
  } as unknown as WebSocket;
  return { socket, close };
}

test("close reasons are truncated to at most 123 UTF-8 bytes", () => {
  const { socket, close } = openSocketSpy();
  closeSocket(socket, 1011, "你".repeat(100));

  const reason = close.mock.calls[0][1] as string;
  expect(new TextEncoder().encode(reason).byteLength).toBeLessThanOrEqual(123);
  expect(reason).not.toContain("�");
});

test("a valid 123-byte close reason remains unchanged", () => {
  const reason = `${"a".repeat(120)}你`;
  expect(new TextEncoder().encode(reason).byteLength).toBe(123);
  expect(truncateUtf8(reason, 123)).toBe(reason);

  const { socket, close } = openSocketSpy();
  closeSocket(socket, 1000, reason);
  expect(close).toHaveBeenCalledWith(1000, reason);
});

test("close code 1005 propagates as an omitted close code", () => {
  const { socket, close } = openSocketSpy();
  closeSocket(socket, 1005, "peer omitted a code");
  expect(close).toHaveBeenCalledWith();
});
