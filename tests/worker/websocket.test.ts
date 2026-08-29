import {
  createExecutionContext,
  evictDurableObject,
  listDurableObjectIds,
  runDurableObjectAlarm,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { clearConfigCacheForTests } from "../../src/config.ts";
import { FAILURE_THRESHOLD } from "../../src/health.ts";
import worker from "../../src/index.ts";
import { ResponsesWebSocketProxy } from "../../src/responses-websocket-proxy.ts";
import type { GatewayConfig } from "../../src/types.ts";

interface UpstreamMessage {
  kind: "text" | "binary";
  data: string | number[];
}

interface UpstreamClose {
  code: number;
  reason: string;
  wasClean: boolean;
}

interface UpstreamPair {
  id: string;
  pendingMessages: UpstreamMessage[];
  pendingCloses: UpstreamClose[];
}

function gatewayConfig(): GatewayConfig {
  return {
    services: [
      {
        id: "primary",
        base_url: "https://primary.example/v1",
        keys: [
          {
            id: "primary-key",
            api_key: "primary-secret",
            disabled: false,
            priority: 100,
          },
          {
            id: "backup-key",
            api_key: "backup-secret",
            disabled: false,
            priority: 50,
          },
        ],
        disabled: false,
        priority: 100,
        supports_websocket: true,
        supports_web_search: false,
        models: ["upstream-model", "other-model"],
      },
    ],
    api_keys: [
      { id: "client", api_key: "client-secret", services: ["primary"] },
    ],
    web_search: { mode: "proxy" },
    model_routes: {
      "client-model": { model: "upstream-model" },
    },
  };
}

function upstreamPair(): UpstreamPair {
  return {
    id: crypto.randomUUID(),
    pendingMessages: [],
    pendingCloses: [],
  };
}

function testUpstream(): Fetcher {
  const binding = Reflect.get(env, "TEST_UPSTREAM");
  if (
    typeof binding !== "object" ||
    binding === null ||
    typeof Reflect.get(binding, "fetch") !== "function"
  ) {
    throw new Error("TEST_UPSTREAM service binding is unavailable");
  }
  return binding as Fetcher;
}

function upstreamControlUrl(
  upstream: UpstreamPair,
  path: string,
  parameters: Record<string, string> = {},
): URL {
  const url = new URL(`https://test-upstream${path}`);
  url.searchParams.set("connection_id", upstream.id);
  for (const [name, value] of Object.entries(parameters)) {
    url.searchParams.set(name, value);
  }
  return url;
}

function openUpstream(
  upstream: UpstreamPair,
  handshakeDelayMs = 0,
): Promise<Response> {
  const url = upstreamControlUrl(upstream, "/responses");
  if (handshakeDelayMs > 0) {
    url.searchParams.set("handshake_delay_ms", String(handshakeDelayMs));
  }
  return testUpstream().fetch(
    new Request(url, {
      method: "GET",
      headers: { upgrade: "websocket" },
    }),
  );
}

async function takeUpstreamMessages(upstream: UpstreamPair): Promise<void> {
  const response = await testUpstream().fetch(
    new Request(upstreamControlUrl(upstream, "/__test/messages")),
  );
  if (response.status === 404) {
    return;
  }
  const body = await response.json<{ messages: UpstreamMessage[] }>();
  upstream.pendingMessages.push(...body.messages);
}

async function takeUpstreamCloses(upstream: UpstreamPair): Promise<void> {
  const response = await testUpstream().fetch(
    new Request(upstreamControlUrl(upstream, "/__test/closes")),
  );
  if (response.status === 404) {
    return;
  }
  const body = await response.json<{ closes: UpstreamClose[] }>();
  upstream.pendingCloses.push(...body.closes);
}

async function waitForUpstreamItem<T>(
  upstream: UpstreamPair,
  pending: T[],
  take: (upstream: UpstreamPair) => Promise<void>,
  label: string,
): Promise<T> {
  const deadline = Date.now() + 2_000;
  while (pending.length === 0 && Date.now() < deadline) {
    await take(upstream);
    if (pending.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  const item = pending.shift();
  if (item === undefined) {
    throw new Error(`timed out waiting for ${label}`);
  }
  return item;
}

async function nextUpstreamMessage(
  upstream: UpstreamPair,
): Promise<string | ArrayBuffer> {
  const message = await waitForUpstreamItem(
    upstream,
    upstream.pendingMessages,
    takeUpstreamMessages,
    "upstream websocket message",
  );
  return message.kind === "text"
    ? (message.data as string)
    : new Uint8Array(message.data as number[]).buffer;
}

function nextUpstreamClose(upstream: UpstreamPair): Promise<UpstreamClose> {
  return waitForUpstreamItem(
    upstream,
    upstream.pendingCloses,
    takeUpstreamCloses,
    "upstream websocket close",
  );
}

async function sendUpstream(
  upstream: UpstreamPair,
  message: string | ArrayBuffer,
): Promise<void> {
  await testUpstream().fetch(
    new Request(upstreamControlUrl(upstream, "/__test/send"), {
      method: "POST",
      headers: typeof message === "string" ? {} : { "x-test-binary": "1" },
      body: message,
    }),
  );
}

async function sendAndCloseUpstream(
  upstream: UpstreamPair,
  message: string,
  code: number,
  reason: string,
): Promise<void> {
  await testUpstream().fetch(
    new Request(
      upstreamControlUrl(upstream, "/__test/send-and-close", {
        code: String(code),
        reason,
      }),
      {
        method: "POST",
        body: message,
      },
    ),
  );
}

async function closeUpstream(
  upstream: UpstreamPair,
  code: number,
  reason: string,
): Promise<void> {
  await testUpstream().fetch(
    new Request(
      upstreamControlUrl(upstream, "/__test/close", {
        code: String(code),
        reason,
      }),
      { method: "POST" },
    ),
  );
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${label}`)),
      2_000,
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

function nextMessage(socket: WebSocket): Promise<string | ArrayBuffer> {
  return withTimeout(
    new Promise((resolve) => {
      socket.addEventListener(
        "message",
        (event) => {
          if (
            typeof event.data === "string" ||
            event.data instanceof ArrayBuffer
          ) {
            resolve(event.data);
            return;
          }
          if (event.data instanceof Blob) {
            void event.data.arrayBuffer().then(resolve);
          }
        },
        { once: true },
      );
    }),
    "websocket message",
  );
}

function nextClose(socket: WebSocket): Promise<CloseEvent> {
  return withTimeout(
    new Promise((resolve) => {
      socket.addEventListener("close", resolve, { once: true });
    }),
    "websocket close",
  );
}

async function putConfig(
  config: ReturnType<typeof gatewayConfig>,
): Promise<void> {
  clearConfigCacheForTests();
  await env.CODY_CONFIG_KV.put("gateway-config", JSON.stringify(config));
}

async function clearRoutingState(): Promise<void> {
  const [healthIds, affinityIds] = await Promise.all([
    listDurableObjectIds(env.HEALTH),
    listDurableObjectIds(env.SESSION_AFFINITY),
  ]);
  await Promise.all([
    ...healthIds.map((id) => env.HEALTH.get(id).clear()),
    ...affinityIds.map((id) => env.SESSION_AFFINITY.get(id).clear()),
  ]);
}

async function openGatewaySocket(
  path = "/v1/responses",
  extraHeaders: Record<string, string> = {},
): Promise<{
  socket: WebSocket;
  context: ExecutionContext;
  proxy: DurableObjectStub<ResponsesWebSocketProxy>;
}> {
  const existingIds = new Set(
    (await listDurableObjectIds(env.RESPONSES_WEBSOCKET)).map((id) =>
      id.toString(),
    ),
  );
  const context = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://gateway.example${path}`, {
      method: "GET",
      headers: {
        authorization: "Bearer client-secret",
        connection: "Upgrade",
        upgrade: "websocket",
        ...extraHeaders,
      },
    }),
    env,
    context,
  );
  expect(response.status).toBe(101);
  expect(response.webSocket).toBeDefined();
  const socket = response.webSocket!;
  socket.binaryType = "arraybuffer";
  socket.accept({ allowHalfOpen: true });
  const createdId = (await listDurableObjectIds(env.RESPONSES_WEBSOCKET)).find(
    (id) => !existingIds.has(id.toString()),
  );
  if (!createdId) {
    throw new Error("Responses WebSocket Durable Object was not created");
  }
  return {
    socket,
    context,
    proxy: env.RESPONSES_WEBSOCKET.get(createdId),
  };
}

beforeEach(async () => {
  vi.unstubAllGlobals();
  clearConfigCacheForTests();
  await clearRoutingState();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("responses WebSocket rewrites the first model and proxies headers, text, binary, and close", async () => {
  await putConfig(gatewayConfig());
  const upstream = upstreamPair();
  let capturedRequest: Request | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedRequest =
        input instanceof Request ? input : new Request(input, init);
      return openUpstream(upstream);
    }),
  );

  const { socket, context } = await openGatewaySocket("/responses?trace=yes", {
    "cf-connecting-ip": "203.0.113.8",
    "sec-websocket-key": "client-generated",
    "session-id": "websocket-session",
    "x-openai-actor-authorization": "cody",
    "x-oai-attestation": "device-attestation",
    "chatgpt-account-id": "account-id",
    "x-tenant": "tenant-a",
  });
  const originalFirstFrame = JSON.stringify({
    type: "response.create",
    model: "client-model",
    client_metadata: { session_id: "metadata-session" },
    input: "hello",
  });
  const upstreamFirstMessage = nextUpstreamMessage(upstream);
  socket.send(originalFirstFrame);
  expect(JSON.parse((await upstreamFirstMessage) as string)).toEqual({
    type: "response.create",
    model: "upstream-model",
    client_metadata: { session_id: "metadata-session" },
    input: "hello",
  });

  expect(capturedRequest?.url).toBe(
    "https://primary.example/v1/responses?trace=yes",
  );
  expect(capturedRequest?.method).toBe("GET");
  expect(capturedRequest?.headers.get("authorization")).toBe(
    "Bearer primary-secret",
  );
  expect(capturedRequest?.headers.get("upgrade")).toBe("websocket");
  expect(capturedRequest?.headers.get("x-tenant")).toBe("tenant-a");
  expect(capturedRequest?.headers.get("cf-connecting-ip")).toBeNull();
  expect(capturedRequest?.headers.get("sec-websocket-key")).toBeNull();
  expect(
    capturedRequest?.headers.get("x-openai-actor-authorization"),
  ).toBeNull();
  expect(capturedRequest?.headers.get("x-oai-attestation")).toBeNull();
  expect(capturedRequest?.headers.get("chatgpt-account-id")).toBeNull();

  const clientText = nextMessage(socket);
  await sendUpstream(
    upstream,
    '{"type":"response.output_text.delta","delta":"hello"}',
  );
  expect(await clientText).toBe(
    '{"type":"response.output_text.delta","delta":"hello"}',
  );

  const upstreamBinary = nextUpstreamMessage(upstream);
  socket.send(new Uint8Array([1, 2, 3]).buffer);
  expect([...new Uint8Array((await upstreamBinary) as ArrayBuffer)]).toEqual([
    1, 2, 3,
  ]);

  const clientBinary = nextMessage(socket);
  await sendUpstream(upstream, new Uint8Array([4, 5, 6]).buffer);
  expect([...new Uint8Array((await clientBinary) as ArrayBuffer)]).toEqual([
    4, 5, 6,
  ]);

  const unchangedFrame =
    '{ "type": "response.create", "model": "upstream-model", "input": "next" }';
  const unchangedUpstream = nextUpstreamMessage(upstream);
  socket.send(unchangedFrame);
  expect(await unchangedUpstream).toBe(unchangedFrame);

  const completed = '{"type":"response.completed"}';
  const clientCompleted = nextMessage(socket);
  await sendUpstream(upstream, completed);
  expect(await clientCompleted).toBe(completed);
  await waitOnExecutionContext(context);

  const upstreamClosed = nextUpstreamClose(upstream);
  socket.close(1000, "client done");
  expect((await upstreamClosed).code).toBe(1000);
});

test("responses WebSocket applies per-client model routes over the global routes", async () => {
  const config = gatewayConfig();
  config.api_keys = [
    config.api_keys[0],
    {
      id: "per-key-client",
      api_key: "per-key-client-secret",
      services: ["primary"],
      model_routes: {
        "client-model": { model: "other-model", services: ["primary"] },
      },
    },
  ];
  await putConfig(config);
  const upstream = upstreamPair();
  let capturedRequest: Request | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedRequest =
        input instanceof Request ? input : new Request(input, init);
      return openUpstream(upstream);
    }),
  );

  const { socket } = await openGatewaySocket("/v1/responses", {
    authorization: "Bearer per-key-client-secret",
  });
  const upstreamFirstMessage = nextUpstreamMessage(upstream);
  socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );
  expect(JSON.parse((await upstreamFirstMessage) as string)).toMatchObject({
    type: "response.create",
    model: "other-model",
  });
  expect(capturedRequest?.url).toBe("https://primary.example/v1/responses");
  expect(capturedRequest?.headers.get("authorization")).toBe(
    "Bearer primary-secret",
  );

  const upstreamClosed = nextUpstreamClose(upstream);
  socket.close(1000, "done");
  await upstreamClosed;
});

test("responses WebSocket applies service model routes over per-client and global routes", async () => {
  const config = gatewayConfig();
  config.services[0].model_routes = {
    "client-model": { model: "other-model" },
  };
  config.api_keys[0].model_routes = {
    "client-model": { model: "upstream-model" },
  };
  await putConfig(config);
  const upstream = upstreamPair();
  let capturedRequest: Request | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedRequest =
        input instanceof Request ? input : new Request(input, init);
      return openUpstream(upstream);
    }),
  );

  const { socket } = await openGatewaySocket("/v1/responses", {
    authorization: "Bearer client-secret",
  });
  const upstreamFirstMessage = nextUpstreamMessage(upstream);
  socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );
  expect(JSON.parse((await upstreamFirstMessage) as string)).toMatchObject({
    type: "response.create",
    model: "other-model",
  });
  expect(capturedRequest?.url).toBe("https://primary.example/v1/responses");

  const upstreamSecondMessage = nextUpstreamMessage(upstream);
  socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );
  expect(JSON.parse((await upstreamSecondMessage) as string)).toMatchObject({
    type: "response.create",
    model: "other-model",
  });

  const upstreamClosed = nextUpstreamClose(upstream);
  socket.close(1000, "done");
  await upstreamClosed;
});

test("responses WebSocket skips higher-priority services without WebSocket support", async () => {
  const config = gatewayConfig();
  config.services[0].supports_websocket = false;
  config.services.push({
    id: "websocket",
    base_url: "https://websocket.example/v1",
    keys: [
      {
        id: "websocket-key",
        api_key: "websocket-secret",
        disabled: false,
        priority: 100,
      },
    ],
    disabled: false,
    priority: 50,
    supports_websocket: true,
    supports_web_search: false,
    models: ["upstream-model"],
  });
  config.api_keys[0].services.push("websocket");
  await putConfig(config);
  const upstream = upstreamPair();
  let capturedRequest: Request | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedRequest =
        input instanceof Request ? input : new Request(input, init);
      return openUpstream(upstream);
    }),
  );

  const { socket } = await openGatewaySocket();
  const firstMessage = nextUpstreamMessage(upstream);
  socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );
  await firstMessage;

  expect(capturedRequest?.url).toBe("https://websocket.example/v1/responses");
  expect(capturedRequest?.headers.get("authorization")).toBe(
    "Bearer websocket-secret",
  );

  const upstreamClosed = nextUpstreamClose(upstream);
  socket.close(1000, "done");
  await upstreamClosed;
});

test("responses WebSocket does not connect when no service declares WebSocket support", async () => {
  const config = gatewayConfig();
  config.services[0].supports_websocket = false;
  await putConfig(config);
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  const { socket } = await openGatewaySocket();
  const errorMessage = nextMessage(socket);
  const closed = nextClose(socket);
  socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );

  expect(JSON.parse((await errorMessage) as string)).toMatchObject({
    type: "error",
    status: 400,
    error: { code: "model_not_found" },
  });
  expect((await closed).code).toBe(1008);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("the first frame must be a response.create JSON text frame", async () => {
  await putConfig(gatewayConfig());
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const { socket } = await openGatewaySocket();
  const errorMessage = nextMessage(socket);
  const closed = nextClose(socket);

  socket.send(new Uint8Array([1, 2, 3]).buffer);
  expect(JSON.parse((await errorMessage) as string)).toMatchObject({
    type: "error",
    status: 400,
    error: { code: "invalid_websocket_first_frame" },
  });
  expect((await closed).code).toBe(1008);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("a WebSocket session emits one structured terminal lifecycle log", async () => {
  await putConfig(gatewayConfig());
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

  try {
    const { socket } = await openGatewaySocket();
    const closed = nextClose(socket);
    socket.send(
      JSON.stringify({ type: "response.create", input: "missing model" }),
    );
    expect((await closed).code).toBe(1008);

    const lifecycle = warn.mock.calls
      .map(([entry]) => entry)
      .filter(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          (entry as { event?: unknown }).event === "websocket.closed",
      );
    expect(lifecycle).toHaveLength(1);
    expect(lifecycle[0]).toMatchObject({
      event: "websocket.closed",
      outcome: "invalid_first_frame",
      close_code: 1008,
      phase: "awaiting_first_frame",
      active_response: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});

test("a connection without a valid first frame times out after 10 seconds", async () => {
  await putConfig(gatewayConfig());
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const { socket, proxy } = await openGatewaySocket();
  const errorMessage = nextMessage(socket);
  const closed = nextClose(socket);
  await runInDurableObject(proxy, async (_instance, state) => {
    const session = await state.storage.get<Record<string, unknown>>("session");
    if (!session) {
      throw new Error("WebSocket session state is missing");
    }
    await state.storage.put("session", {
      ...session,
      first_frame_deadline: Date.now() - 1,
    });
  });

  expect(await runDurableObjectAlarm(proxy)).toBe(true);
  expect(JSON.parse((await errorMessage) as string)).toMatchObject({
    type: "error",
    status: 408,
    error: { code: "websocket_first_frame_timeout" },
  });
  expect((await closed).code).toBe(1008);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("an expired first-frame alarm cannot close a session already claimed for routing", async () => {
  await putConfig(gatewayConfig());
  const { socket, proxy } = await openGatewaySocket();
  await runInDurableObject(proxy, async (_instance, state) => {
    const session = await state.storage.get<Record<string, unknown>>("session");
    if (!session) {
      throw new Error("WebSocket session state is missing");
    }
    await state.storage.put("session", {
      ...session,
      phase: "routing",
      first_frame_deadline: Date.now() - 1,
    });
  });

  expect(await runDurableObjectAlarm(proxy)).toBe(true);
  await runInDurableObject(proxy, async (_instance, state) => {
    expect(await state.storage.get("session")).toMatchObject({
      phase: "routing",
    });
  });
  expect(socket.readyState).toBe(WebSocket.OPEN);
  const closed = nextClose(socket);
  await runInDurableObject(
    proxy,
    async (instance: ResponsesWebSocketProxy, state) => {
      const server = state.getWebSockets("client")[0];
      if (!server) {
        throw new Error("Client WebSocket is missing");
      }
      await instance.webSocketClose(server, 1000, "done", true);
    },
  );
  expect((await closed).code).toBe(1000);
  await vi.waitFor(async () => {
    await runInDurableObject(proxy, async (_instance, state) => {
      expect(await state.storage.get("session")).toBeUndefined();
    });
  });
});

test("more than 32 MiB of queued client messages closes the connection", async () => {
  await putConfig(gatewayConfig());
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    return new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener(
        "abort",
        () => {
          reject(new DOMException("aborted", "AbortError"));
        },
        { once: true },
      );
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  const { socket } = await openGatewaySocket();
  socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

  const errorMessage = nextMessage(socket);
  const closed = nextClose(socket);
  const chunk = new ArrayBuffer(17 * 1024 * 1024);
  socket.send(chunk);
  socket.send(chunk.slice(0));

  expect(JSON.parse((await errorMessage) as string)).toMatchObject({
    type: "error",
    status: 413,
    error: { code: "websocket_queue_too_large" },
  });
  expect((await closed).code).toBe(1009);
});

test("the client WebSocket survives Durable Object hibernation before routing", async () => {
  await putConfig(gatewayConfig());
  const upstream = upstreamPair();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => openUpstream(upstream)),
  );

  const { socket, proxy } = await openGatewaySocket();
  await evictDurableObject(proxy);

  const firstUpstreamMessage = nextUpstreamMessage(upstream);
  socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );
  expect(JSON.parse((await firstUpstreamMessage) as string)).toMatchObject({
    type: "response.create",
    model: "upstream-model",
  });

  const upstreamClosed = nextUpstreamClose(upstream);
  socket.close(1000, "done");
  await upstreamClosed;
});

test("closing during the upstream handshake cannot revive a closed session", async () => {
  await putConfig(gatewayConfig());
  const upstream = upstreamPair();
  const fetchMock = vi.fn(async () => openUpstream(upstream, 100));
  vi.stubGlobal("fetch", fetchMock);

  const { socket, proxy } = await openGatewaySocket();
  socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

  socket.close(1000, "client left");
  await vi.waitFor(async () => {
    await runInDurableObject(proxy, async (_instance, state) => {
      expect(await state.storage.get("session")).toBeUndefined();
    });
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  await runInDurableObject(proxy, async (_instance, state) => {
    expect(await state.storage.get("session")).toBeUndefined();
  });
  await takeUpstreamMessages(upstream);
  expect(upstream.pendingMessages).toHaveLength(0);
});

test("an upstream WebSocket handshake times out after 10 seconds", async () => {
  await putConfig(gatewayConfig());
  const realSetTimeout = globalThis.setTimeout;
  vi.stubGlobal(
    "setTimeout",
    (
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ): number => {
      if (delay === 10_000) {
        callback(...args);
        return 0;
      }
      return realSetTimeout(callback, delay, ...args);
    },
  );
  let requestAborted = false;
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    return new Promise<Response>((_resolve, reject) => {
      if (request.signal.aborted) {
        requestAborted = true;
        reject(request.signal.reason);
        return;
      }
      request.signal.addEventListener(
        "abort",
        () => {
          requestAborted = true;
          reject(request.signal.reason);
        },
        { once: true },
      );
    });
  });
  vi.stubGlobal("fetch", fetchMock);

  const { socket } = await openGatewaySocket();
  const errorMessage = new Promise<string | ArrayBuffer>((resolve) => {
    socket.addEventListener(
      "message",
      (event) => {
        if (
          typeof event.data === "string" ||
          event.data instanceof ArrayBuffer
        ) {
          resolve(event.data);
        }
      },
      { once: true },
    );
  });
  const closed = new Promise<CloseEvent>((resolve) => {
    socket.addEventListener("close", resolve, { once: true });
  });
  socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );

  expect(JSON.parse((await errorMessage) as string)).toMatchObject({
    type: "error",
    status: 504,
    error: { code: "upstream_handshake_timeout" },
  });
  expect((await closed).code).toBe(1011);
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(requestAborted).toBe(true);
  await vi.waitFor(async () => {
    expect((await env.HEALTH.getByName("primary").getStatus()).failures).toBe(
      1,
    );
  });
});

test("a retrying 403 handshake cools the key, keeps the same key for retry, then rebinds on reconnect", async () => {
  const config = gatewayConfig();
  config.services[0].retry = { status_codes: [403], delays_ms: [0] };
  await putConfig(config);
  const retryUpstream = upstreamPair();
  const reboundUpstream = upstreamPair();
  const authorizations: string[] = [];
  let attempt = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      authorizations.push(request.headers.get("authorization") ?? "");
      attempt += 1;
      if (attempt === 1) {
        return new Response('{"error":"forbidden"}', { status: 403 });
      }
      return attempt === 2
        ? openUpstream(retryUpstream)
        : openUpstream(reboundUpstream);
    }),
  );

  const first = await openGatewaySocket("/v1/responses", {
    "session-id": "retry-session",
  });
  const firstUpstreamMessage = nextUpstreamMessage(retryUpstream);
  first.socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );
  expect(JSON.parse((await firstUpstreamMessage) as string)).toMatchObject({
    type: "response.create",
    model: "upstream-model",
  });
  await waitOnExecutionContext(first.context);
  expect(authorizations.slice(0, 2)).toEqual([
    "Bearer primary-secret",
    "Bearer primary-secret",
  ]);
  expect(
    (await env.HEALTH.getByName("key:primary:primary-key").getStatus())
      .cooling_until,
  ).toBeTypeOf("number");

  const firstUpstreamClosed = nextUpstreamClose(retryUpstream);
  first.socket.close(1000, "reconnect");
  await firstUpstreamClosed;

  const second = await openGatewaySocket("/v1/responses", {
    "session-id": "retry-session",
  });
  const secondUpstreamMessage = nextUpstreamMessage(reboundUpstream);
  second.socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );
  expect(JSON.parse((await secondUpstreamMessage) as string)).toMatchObject({
    type: "response.create",
    model: "upstream-model",
  });
  expect(authorizations.at(-1)).toBe("Bearer backup-secret");

  const secondUpstreamClosed = nextUpstreamClose(reboundUpstream);
  second.socket.close(1000, "done");
  await secondUpstreamClosed;
});

test("a final upstream handshake rejection is forwarded and records service health", async () => {
  await putConfig(gatewayConfig());
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response('{"error":"temporarily unavailable"}', {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
    ),
  );

  const { socket, context } = await openGatewaySocket();
  const errorMessage = nextMessage(socket);
  const closed = nextClose(socket);
  socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );

  expect(await errorMessage).toBe('{"error":"temporarily unavailable"}');
  expect((await closed).code).toBe(1011);
  await waitOnExecutionContext(context);
  expect((await env.HEALTH.getByName("primary").getStatus()).failures).toBe(1);
});

test("an upstream 402 frame is processed before an immediate close", async () => {
  await putConfig(gatewayConfig());
  const upstream = upstreamPair();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => openUpstream(upstream)),
  );
  const { socket, context } = await openGatewaySocket();
  const upstreamFirst = nextUpstreamMessage(upstream);
  socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );
  await upstreamFirst;

  const errorFrame = JSON.stringify({
    type: "error",
    error: {
      status_code: "402",
      code: "billing_error",
      message: "payment required",
    },
  });
  const forwarded = nextMessage(socket);
  const closed = nextClose(socket);
  const upstreamClosed = nextUpstreamClose(upstream);
  await sendAndCloseUpstream(upstream, errorFrame, 1011, "billing rejected");
  expect(await forwarded).toBe(errorFrame);
  expect((await closed).code).toBe(1011);
  await upstreamClosed;
  await waitOnExecutionContext(context);
  expect(
    (await env.HEALTH.getByName("key:primary:primary-key").getStatus())
      .cooling_until,
  ).toBeTypeOf("number");
  expect((await env.HEALTH.getByName("primary").getStatus()).failures).toBe(0);
});

test("an upstream 403 frame cools the key when the client socket is unavailable", async () => {
  await putConfig(gatewayConfig());
  const upstream = upstreamPair();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => openUpstream(upstream)),
  );
  const { socket, proxy, context } = await openGatewaySocket();
  const upstreamFirst = nextUpstreamMessage(upstream);
  socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );
  await upstreamFirst;

  await runInDurableObject(proxy, async (_instance, state) => {
    const client = state.getWebSockets("client")[0];
    if (!client) {
      throw new Error("Client WebSocket is missing");
    }
    client.close(1000, "simulate unavailable client");
  });

  const upstreamClosed = nextUpstreamClose(upstream);
  await sendUpstream(
    upstream,
    JSON.stringify({
      type: "error",
      error: {
        status_code: 403,
        code: "forbidden",
        message: "access denied",
      },
    }),
  );
  await upstreamClosed;
  await waitOnExecutionContext(context);

  expect(
    (await env.HEALTH.getByName("key:primary:primary-key").getStatus())
      .cooling_until,
  ).toBeTypeOf("number");
});

test("every upstream error frame is forwarded before the connection closes", async () => {
  await putConfig(gatewayConfig());
  const upstream = upstreamPair();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => openUpstream(upstream)),
  );
  const { socket } = await openGatewaySocket();
  const upstreamFirst = nextUpstreamMessage(upstream);
  socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );
  await upstreamFirst;

  const errorFrame = JSON.stringify({
    type: "error",
    error: { code: "upstream_error", message: "request failed" },
  });
  const forwarded = nextMessage(socket);
  const closed = nextClose(socket);
  const upstreamClosed = nextUpstreamClose(upstream);
  await sendUpstream(upstream, errorFrame);

  expect(await forwarded).toBe(errorFrame);
  expect((await closed).code).toBe(1011);
  await upstreamClosed;
});

test("an unexpected upstream close propagates and records a service failure", async () => {
  await putConfig(gatewayConfig());
  const upstream = upstreamPair();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => openUpstream(upstream)),
  );
  const { socket, context } = await openGatewaySocket();
  const firstFrame = nextUpstreamMessage(upstream);
  socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );
  await firstFrame;

  const clientClosed = nextClose(socket);
  await closeUpstream(upstream, 1011, "upstream lost");
  expect((await clientClosed).code).toBe(1011);
  await waitOnExecutionContext(context);
  expect((await env.HEALTH.getByName("primary").getStatus()).failures).toBe(1);
});

test("an upstream close while connecting records a service failure", async () => {
  await putConfig(gatewayConfig());
  const upstream = upstreamPair();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => openUpstream(upstream)),
  );
  const { socket, proxy, context } = await openGatewaySocket();
  const firstFrame = nextUpstreamMessage(upstream);
  socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );
  await firstFrame;

  await runInDurableObject(proxy, async (_instance, state) => {
    const session = await state.storage.get<Record<string, unknown>>("session");
    if (!session) {
      throw new Error("WebSocket session state is missing");
    }
    await state.storage.put("session", {
      ...session,
      phase: "connecting",
      active_response: false,
      response_outcome_recorded: false,
    });
  });

  const clientClosed = nextClose(socket);
  await closeUpstream(upstream, 1011, "closed before ready");
  expect((await clientClosed).code).toBe(1011);
  await waitOnExecutionContext(context);
  expect((await env.HEALTH.getByName("primary").getStatus()).failures).toBe(1);
});

test("a later response.create that requires another target closes and rebinds on reconnect", async () => {
  const config = gatewayConfig();
  config.services = [
    {
      id: "first",
      base_url: "https://first.example/v1",
      keys: [
        {
          id: "first-key",
          api_key: "first-secret",
          disabled: false,
          priority: 100,
        },
      ],
      disabled: false,
      priority: 100,
      supports_websocket: true,
      supports_web_search: false,
      models: ["model-a"],
    },
    {
      id: "second",
      base_url: "https://second.example/v1",
      keys: [
        {
          id: "second-key",
          api_key: "second-secret",
          disabled: false,
          priority: 100,
        },
      ],
      disabled: false,
      priority: 100,
      supports_websocket: true,
      supports_web_search: false,
      models: ["model-b"],
    },
  ];
  config.api_keys[0].services = ["first", "second"];
  config.model_routes = {
    "client-a": { model: "model-a" },
    "client-b": { model: "model-b" },
  };
  await putConfig(config);
  const firstUpstream = upstreamPair();
  const secondUpstream = upstreamPair();
  const authorizations: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      authorizations.push(request.headers.get("authorization") ?? "");
      return authorizations.length === 1
        ? openUpstream(firstUpstream)
        : openUpstream(secondUpstream);
    }),
  );

  const first = await openGatewaySocket("/v1/responses", {
    "session-id": "model-switch-session",
  });
  const firstUpstreamMessage = nextUpstreamMessage(firstUpstream);
  first.socket.send(
    JSON.stringify({ type: "response.create", model: "client-a" }),
  );
  await firstUpstreamMessage;
  expect(authorizations[0]).toBe("Bearer first-secret");

  const reconnectError = nextMessage(first.socket);
  const firstClosed = nextClose(first.socket);
  const firstUpstreamClosed = nextUpstreamClose(firstUpstream);
  first.socket.send(
    JSON.stringify({ type: "response.create", model: "client-b" }),
  );
  expect(JSON.parse((await reconnectError) as string)).toMatchObject({
    type: "error",
    error: { code: "websocket_reconnect_required" },
  });
  expect((await firstClosed).code).toBe(1012);
  await firstUpstreamClosed;
  expect(authorizations).toHaveLength(1);

  const second = await openGatewaySocket("/v1/responses", {
    "session-id": "model-switch-session",
  });
  const secondUpstreamMessage = nextUpstreamMessage(secondUpstream);
  second.socket.send(
    JSON.stringify({ type: "response.create", model: "client-b" }),
  );
  expect(JSON.parse((await secondUpstreamMessage) as string)).toMatchObject({
    type: "response.create",
    model: "model-b",
  });
  expect(authorizations[1]).toBe("Bearer second-secret");

  const secondUpstreamClosed = nextUpstreamClose(secondUpstream);
  second.socket.close(1000, "done");
  await secondUpstreamClosed;
});

test("a recovered higher-priority service changes affinity and requires WebSocket reconnect", async () => {
  const config = gatewayConfig();
  config.services = [
    {
      id: "higher",
      base_url: "https://higher.example/v1",
      keys: [
        {
          id: "higher-key",
          api_key: "higher-secret",
          disabled: false,
          priority: 10,
        },
      ],
      disabled: false,
      priority: 100,
      supports_websocket: true,
      supports_web_search: false,
      models: ["upstream-model"],
    },
    {
      id: "lower",
      base_url: "https://lower.example/v1",
      keys: [
        {
          id: "lower-key",
          api_key: "lower-secret",
          disabled: false,
          priority: 100,
        },
      ],
      disabled: false,
      priority: 10,
      supports_websocket: true,
      supports_web_search: false,
      models: ["upstream-model"],
    },
  ];
  config.api_keys[0].services = ["higher", "lower"];
  await putConfig(config);
  for (let index = 0; index < FAILURE_THRESHOLD; index += 1) {
    await env.HEALTH.getByName("higher").recordFailure();
  }

  const lowerUpstream = upstreamPair();
  const higherUpstream = upstreamPair();
  const authorizations: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      authorizations.push(request.headers.get("authorization") ?? "");
      return authorizations.length === 1
        ? openUpstream(lowerUpstream)
        : openUpstream(higherUpstream);
    }),
  );

  const first = await openGatewaySocket("/v1/responses", {
    "session-id": "priority-upgrade-session",
  });
  const firstMessage = nextUpstreamMessage(lowerUpstream);
  first.socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );
  await firstMessage;
  expect(authorizations[0]).toBe("Bearer lower-secret");

  await env.HEALTH.getByName("higher").clear();
  const reconnectError = nextMessage(first.socket);
  const firstClosed = nextClose(first.socket);
  const lowerClosed = nextUpstreamClose(lowerUpstream);
  first.socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );
  expect(JSON.parse((await reconnectError) as string)).toMatchObject({
    type: "error",
    error: { code: "websocket_reconnect_required" },
  });
  expect((await firstClosed).code).toBe(1012);
  await lowerClosed;

  const second = await openGatewaySocket("/v1/responses", {
    "session-id": "priority-upgrade-session",
  });
  const secondMessage = nextUpstreamMessage(higherUpstream);
  second.socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );
  await secondMessage;
  expect(authorizations[1]).toBe("Bearer higher-secret");

  const higherClosed = nextUpstreamClose(higherUpstream);
  second.socket.close(1000, "done");
  await higherClosed;
});

test("a later response.create reloads configuration and closes when WebSocket support is revoked", async () => {
  const config = gatewayConfig();
  await putConfig(config);
  const upstream = upstreamPair();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => openUpstream(upstream)),
  );

  const { socket } = await openGatewaySocket();
  const firstUpstreamMessage = nextUpstreamMessage(upstream);
  socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );
  await firstUpstreamMessage;

  const completed = nextMessage(socket);
  await sendUpstream(upstream, JSON.stringify({ type: "response.completed" }));
  await completed;

  config.services[0].supports_websocket = false;
  await putConfig(config);

  const reconnectError = nextMessage(socket);
  const clientClosed = nextClose(socket);
  const upstreamClosed = nextUpstreamClose(upstream);
  socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );

  expect(JSON.parse((await reconnectError) as string)).toMatchObject({
    type: "error",
    status: 503,
    error: { code: "websocket_reconnect_required" },
  });
  expect((await clientClosed).code).toBe(1012);
  await upstreamClosed;
  await takeUpstreamMessages(upstream);
  expect(upstream.pendingMessages).toHaveLength(0);
});

test("a later response.create reauthenticates the client against current configuration", async () => {
  const config = gatewayConfig();
  await putConfig(config);
  const upstream = upstreamPair();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => openUpstream(upstream)),
  );

  const { socket } = await openGatewaySocket();
  const firstUpstreamMessage = nextUpstreamMessage(upstream);
  socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );
  await firstUpstreamMessage;

  const completed = nextMessage(socket);
  await sendUpstream(upstream, JSON.stringify({ type: "response.completed" }));
  await completed;

  config.api_keys = [
    {
      id: "replacement-client",
      api_key: "replacement-client",
      services: ["primary"],
    },
  ];
  await putConfig(config);

  const authenticationError = nextMessage(socket);
  const clientClosed = nextClose(socket);
  const upstreamClosed = nextUpstreamClose(upstream);
  socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );

  expect(JSON.parse((await authenticationError) as string)).toMatchObject({
    type: "error",
    status: 401,
    error: { code: "invalid_api_key" },
  });
  expect((await clientClosed).code).toBe(1008);
  await upstreamClosed;
  await takeUpstreamMessages(upstream);
  expect(upstream.pendingMessages).toHaveLength(0);
});

test("an invalid later response.create is rejected instead of bypassing model validation", async () => {
  await putConfig(gatewayConfig());
  const upstream = upstreamPair();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => openUpstream(upstream)),
  );

  const { socket } = await openGatewaySocket();
  const firstUpstreamMessage = nextUpstreamMessage(upstream);
  socket.send(
    JSON.stringify({ type: "response.create", model: "client-model" }),
  );
  await firstUpstreamMessage;

  const validationError = nextMessage(socket);
  const clientClosed = nextClose(socket);
  const upstreamClosed = nextUpstreamClose(upstream);
  socket.send(
    JSON.stringify({ type: "response.create", input: "missing model" }),
  );

  expect(JSON.parse((await validationError) as string)).toMatchObject({
    type: "error",
    status: 400,
    error: { code: "invalid_websocket_response_create" },
  });
  expect((await clientClosed).code).toBe(1008);
  await upstreamClosed;
  await takeUpstreamMessages(upstream);
  expect(upstream.pendingMessages).toHaveLength(0);
});

test("custom WebSocket subprotocols are rejected before an upstream connection", async () => {
  await putConfig(gatewayConfig());
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const context = createExecutionContext();
  const response = await worker.fetch(
    new Request("https://gateway.example/v1/responses", {
      method: "GET",
      headers: {
        authorization: "Bearer client-secret",
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-protocol": "custom",
      },
    }),
    env,
    context,
  );

  expect(response.status).toBe(400);
  expect((await response.json<{ error: { code: string } }>()).error.code).toBe(
    "websocket_subprotocol_unsupported",
  );
  expect(fetchMock).not.toHaveBeenCalled();
});
