import assert from "node:assert/strict";
import test from "node:test";

import { ServiceHealthState } from "../src/health.ts";
import {
  anthropicErrorType,
  apiError,
  findClientApiKey,
  forwardRequestHeaders,
  forwardWebSocketHeaders,
  requestCredentialTokens,
} from "../src/http.ts";
import {
  handleInference,
  sessionIdForInference,
  upstreamBody,
} from "../src/proxy.ts";

function inferenceFixture(retry) {
  const service = {
    id: "primary",
    base_url: "https://primary.example/v1",
    keys: [
      {
        id: "primary-key",
        api_key: "service-secret-key",
        disabled: false,
        priority: 100,
      },
      {
        id: "backup-key",
        api_key: "service-backup-key",
        disabled: false,
        priority: 50,
      },
    ],
    disabled: false,
    priority: 100,
    supports_websocket: false,
    supports_web_search: true,
    models: ["model"],
    ...(retry === undefined ? {} : { retry }),
  };
  const calls = { failure: 0, keyFailure: 0, success: 0 };
  const healthObjects = new Map();
  const affinities = new Map();
  const healthObject = (name) => {
    if (!healthObjects.has(name)) {
      const state = new ServiceHealthState();
      healthObjects.set(name, {
        clear: async () => state.clear(),
        getStatus: async () => state.getStatus(),
        recordFailure: async () => {
          calls.failure += 1;
          return state.recordFailure();
        },
        recordImmediateFailure: async () => {
          calls.keyFailure += 1;
          return state.recordImmediateFailure();
        },
        recordSuccess: async () => {
          calls.success += 1;
          return state.recordSuccess();
        },
      });
    }
    return healthObjects.get(name);
  };
  return {
    affinities,
    calls,
    client: { id: "client", api_key: "client", services: [service.id] },
    config: {
      services: [service],
      api_keys: [{ id: "client", api_key: "client", services: [service.id] }],
      model_routes: {},
    },
    env: {
      HEALTH: {
        getByName: healthObject,
      },
      SESSION_AFFINITY: {
        getByName: (name) => ({
          resolve: async (candidates, preferred) => {
            const stored = affinities.get(name);
            const isCandidate = (selection) =>
              selection !== undefined &&
              candidates.some(
                (candidate) =>
                  candidate.service_id === selection.service_id &&
                  candidate.keys.some((key) => key.key_id === selection.key_id),
              );
            if (isCandidate(stored)) {
              return { ...stored, updated_at: Date.now(), status: "hit" };
            }
            if (!isCandidate(preferred)) {
              return undefined;
            }
            const status = stored === undefined ? "created" : "rebound";
            const next = { ...preferred, updated_at: Date.now() };
            affinities.set(name, next);
            return { ...next, status };
          },
        }),
      },
    },
  };
}

function inferenceRequest() {
  return new Request("https://gateway.example/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "model", input: "hello" }),
  });
}

test("request bytes are forwarded untouched when nothing changed", () => {
  const original = '{\n  "model": "grok-4.5",\n  "stream": true\n}';
  const rawBody = new TextEncoder().encode(original);
  const body = upstreamBody(rawBody, JSON.parse(original), "grok-4.5", false);
  // The same buffer is forwarded, so whitespace and key order survive exactly.
  assert.equal(body, rawBody);
  assert.equal(new TextDecoder().decode(body), original);
});

test("a rewritten body changes only the model value semantically", () => {
  const original = '{"model":"gpt-5.6-sol","stream":true,"input":"hello"}';
  const body = upstreamBody(
    new TextEncoder().encode(original),
    JSON.parse(original),
    "grok-4.5",
    true,
  );
  assert.deepEqual(JSON.parse(body), {
    model: "grok-4.5",
    stream: true,
    input: "hello",
  });
});

test("a rewritten body keeps payload mutations when the model is unchanged", () => {
  // The identity injection mutates the parsed payload without touching the
  // model. Serializing must still pick those mutations up.
  const original = '{"model":"grok-4.5","messages":[]}';
  const payload = JSON.parse(original);
  payload.system = [{ type: "text", text: "marker" }];
  const body = upstreamBody(
    new TextEncoder().encode(original),
    payload,
    "grok-4.5",
    true,
  );
  assert.deepEqual(JSON.parse(body), {
    model: "grok-4.5",
    messages: [],
    system: [{ type: "text", text: "marker" }],
  });
});

test("session identifiers use header, metadata, then search id precedence", () => {
  const headerRequest = new Request("https://gateway.example/v1/responses", {
    headers: { "session-id": " header-session ", "thread-id": "thread" },
  });
  assert.equal(
    sessionIdForInference(
      headerRequest,
      {
        model: "model",
        client_metadata: { session_id: "metadata" },
        id: "search",
      },
      "responses",
    ),
    "header-session",
  );
  assert.equal(
    sessionIdForInference(
      new Request("https://gateway.example/v1/responses", {
        headers: { "thread-id": "thread-only" },
      }),
      { model: "model", client_metadata: { session_id: " metadata " } },
      "responses",
    ),
    " metadata ",
  );
  assert.equal(
    sessionIdForInference(
      new Request("https://gateway.example/v1/alpha/search", {
        headers: { "thread-id": "thread-only" },
      }),
      { model: "model", id: "search-id" },
      "alpha/search",
    ),
    "search-id",
  );
  assert.equal(
    sessionIdForInference(
      new Request("https://gateway.example/v1/responses", {
        headers: { "thread-id": "thread-only" },
      }),
      { model: "model", id: "search-id" },
      "responses",
    ),
    undefined,
  );
});

test("session identifiers come from an Anthropic metadata user id", () => {
  const request = new Request("https://gateway.example/v1/messages", {
    headers: { "anthropic-version": "2023-06-01" },
  });
  // Claude Code sends the session inside metadata.user_id as a JSON string.
  assert.equal(
    sessionIdForInference(
      request,
      {
        model: "claude-opus-5",
        metadata: {
          user_id: JSON.stringify({
            device_id: "device-1",
            session_id: "claude-session",
          }),
        },
      },
      "messages",
    ),
    "claude-session",
  );
  // Also accepted as an object, matching the identity injection.
  assert.equal(
    sessionIdForInference(
      request,
      {
        model: "claude-opus-5",
        metadata: { user_id: { session_id: "object-session" } },
      },
      "messages",
    ),
    "object-session",
  );
  // client_metadata still wins over the Anthropic metadata.
  assert.equal(
    sessionIdForInference(
      request,
      {
        model: "claude-opus-5",
        client_metadata: { session_id: "codex-session" },
        metadata: { user_id: JSON.stringify({ session_id: "claude-session" }) },
      },
      "messages",
    ),
    "codex-session",
  );
  for (const metadata of [
    undefined,
    {},
    { user_id: "not json" },
    { user_id: "[]" },
    { user_id: JSON.stringify({ device_id: "device-only" }) },
    { user_id: JSON.stringify({ session_id: "  " }) },
    { user_id: 42 },
  ]) {
    assert.equal(
      sessionIdForInference(request, { model: "m", metadata }, "messages"),
      undefined,
    );
  }
});

test("count_tokens binds to the same session as the matching message", () => {
  const payload = {
    model: "claude-opus-5",
    metadata: { user_id: JSON.stringify({ session_id: "shared-session" }) },
  };
  const request = new Request("https://gateway.example/v1/messages", {
    headers: { "anthropic-version": "2023-06-01" },
  });
  assert.equal(
    sessionIdForInference(request, payload, "messages"),
    sessionIdForInference(request, payload, "messages/count_tokens"),
  );
});

test("Responses bodies remain unchanged when image generation is routable", async () => {
  const fixture = inferenceFixture();
  fixture.config.services[0].models.push("upstream-image-model");
  fixture.config.model_routes["gpt-image-2"] = {
    model: "upstream-image-model",
  };
  const originalBody =
    '{\n  "model": "model",\n  "input": "draw",\n  "tools": []\n}\n';
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    captured = {
      contentMd5: request.headers.get("content-md5"),
      digest: request.headers.get("digest"),
      contentDigest: request.headers.get("content-digest"),
      body: await request.text(),
    };
    return new Response(null, { status: 200 });
  };

  try {
    const response = await handleInference(
      new Request("https://gateway.example/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-md5": "original-md5",
          digest: "original-digest",
          "content-digest": "original-content-digest",
        },
        body: originalBody,
      }),
      fixture.env,
      fixture.config,
      fixture.client,
      "responses",
    );
    assert.equal(response.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(captured, {
    contentMd5: "original-md5",
    digest: "original-digest",
    contentDigest: "original-content-digest",
    body: originalBody,
  });
});

test("Image API requests preserve the original JSON body when the model is unchanged", async () => {
  const originalFetch = globalThis.fetch;
  const fixture = inferenceFixture();
  const originalBody = '{\n  "model": "model",\n  "prompt": "draw a fox"\n}\n';
  let capturedBody;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    capturedBody = await request.text();
    return new Response(null, { status: 200 });
  };

  try {
    const response = await handleInference(
      new Request("https://gateway.example/v1/images/generations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: originalBody,
      }),
      fixture.env,
      fixture.config,
      fixture.client,
      "images/generations",
    );
    assert.equal(response.status, 200);
    assert.equal(capturedBody, originalBody);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Image API requests route gpt-image-2 through its model route", async () => {
  const originalFetch = globalThis.fetch;
  const fixture = inferenceFixture();
  fixture.config.services[0].models = ["upstream-image-model"];
  fixture.config.model_routes = {
    "gpt-image-2": { model: "upstream-image-model" },
  };
  let capturedBody;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    capturedBody = JSON.parse(await request.text());
    return new Response(null, { status: 200 });
  };

  try {
    const response = await handleInference(
      new Request("https://gateway.example/v1/images/generations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-image-2", prompt: "draw a fox" }),
      }),
      fixture.env,
      fixture.config,
      fixture.client,
      "images/generations",
    );
    assert.equal(response.status, 200);
    assert.deepEqual(capturedBody, {
      model: "upstream-image-model",
      prompt: "draw a fox",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("model routes rewrite only the model and invalidate body digests", async () => {
  const fixture = inferenceFixture();
  fixture.config.services[0].models = ["upstream-model"];
  fixture.config.model_routes = { "client-model": { model: "upstream-model" } };
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    captured = {
      contentMd5: request.headers.get("content-md5"),
      digest: request.headers.get("digest"),
      contentDigest: request.headers.get("content-digest"),
      contentEncoding: request.headers.get("content-encoding"),
      body: JSON.parse(await request.text()),
    };
    return new Response(null, { status: 200 });
  };

  try {
    const response = await handleInference(
      new Request("https://gateway.example/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-md5": "stale-md5",
          digest: "stale-digest",
          "content-digest": "stale-content-digest",
          "content-encoding": "gzip",
        },
        body: JSON.stringify({ model: "client-model", input: "hello" }),
      }),
      fixture.env,
      fixture.config,
      fixture.client,
      "responses",
    );
    assert.equal(response.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(captured, {
    contentMd5: null,
    digest: null,
    contentDigest: null,
    contentEncoding: null,
    body: {
      model: "upstream-model",
      input: "hello",
    },
  });
});

test("claude code identity is injected for /v1/messages on enabled services", async () => {
  const fixture = inferenceFixture();
  fixture.config.services[0].inject_claude_code_identity = true;
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    captured = {
      contentMd5: request.headers.get("content-md5"),
      digest: request.headers.get("digest"),
      contentDigest: request.headers.get("content-digest"),
      anthropicBeta: request.headers.get("anthropic-beta"),
      userAgent: request.headers.get("user-agent"),
      xApp: request.headers.get("x-app"),
      body: JSON.parse(await request.text()),
    };
    return new Response(null, { status: 200 });
  };

  try {
    const response = await handleInference(
      new Request("https://gateway.example/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-md5": "stale-md5",
          digest: "stale-digest",
          "content-digest": "stale-content-digest",
          "anthropic-beta": "interleaved-thinking-2025-05-14",
        },
        body: JSON.stringify({ model: "model", messages: [], system: "hi" }),
      }),
      fixture.env,
      fixture.config,
      fixture.client,
      "messages",
    );
    assert.equal(response.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(captured.contentMd5, null);
  assert.equal(captured.digest, null);
  assert.equal(captured.contentDigest, null);
  assert.equal(
    captured.anthropicBeta,
    "claude-code-20250219,interleaved-thinking-2025-05-14",
  );
  assert.equal(captured.userAgent, "claude-cli/2.1.246 (external, sdk-cli)");
  assert.equal(captured.xApp, "cli");
  assert.equal(captured.body.model, "model");
  assert.equal(captured.body.system[0].type, "text");
  assert.equal(
    captured.body.system[0].text,
    "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
  );
  assert.equal(captured.body.system[1].text, "hi");
  const userId = JSON.parse(captured.body.metadata.user_id);
  assert.equal(typeof userId.device_id, "string");
  assert.equal(typeof userId.session_id, "string");
});

test("claude code identity headers are added even when the body already has them", async () => {
  const fixture = inferenceFixture();
  fixture.config.services[0].inject_claude_code_identity = true;
  const marker =
    "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
  const originalBody = JSON.stringify({
    model: "model",
    messages: [{ role: "user", content: "hi" }],
    system: [{ type: "text", text: marker }],
    metadata: {
      user_id: JSON.stringify({
        device_id: "device-1",
        session_id: "session-1",
      }),
    },
  });
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    captured = {
      userAgent: request.headers.get("user-agent"),
      xApp: request.headers.get("x-app"),
      anthropicBeta: request.headers.get("anthropic-beta"),
      body: await request.text(),
    };
    return new Response(null, { status: 200 });
  };

  try {
    const response = await handleInference(
      new Request("https://gateway.example/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: originalBody,
      }),
      fixture.env,
      fixture.config,
      fixture.client,
      "messages",
    );
    assert.equal(response.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(captured.userAgent, "claude-cli/2.1.246 (external, sdk-cli)");
  assert.equal(captured.xApp, "cli");
  assert.equal(captured.anthropicBeta, "claude-code-20250219");
  assert.equal(captured.body, originalBody);
});

test("model rewrite keeps the injected claude code identity", async () => {
  const fixture = inferenceFixture();
  fixture.config.services[0].inject_claude_code_identity = true;
  fixture.config.services[0].models = ["upstream-model"];
  fixture.config.model_routes = { "client-model": { model: "upstream-model" } };
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    captured = {
      userAgent: request.headers.get("user-agent"),
      xApp: request.headers.get("x-app"),
      anthropicBeta: request.headers.get("anthropic-beta"),
      body: JSON.parse(await request.text()),
    };
    return new Response(null, { status: 200 });
  };

  try {
    const response = await handleInference(
      new Request("https://gateway.example/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "client-model",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      fixture.env,
      fixture.config,
      fixture.client,
      "messages",
    );
    assert.equal(response.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(captured.userAgent, "claude-cli/2.1.246 (external, sdk-cli)");
  assert.equal(captured.xApp, "cli");
  assert.equal(captured.anthropicBeta, "claude-code-20250219");
  assert.equal(captured.body.model, "upstream-model");
  assert.equal(
    captured.body.system[0].text,
    "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
  );
  assert.equal(
    typeof JSON.parse(captured.body.metadata.user_id).device_id,
    "string",
  );
  assert.equal(
    typeof JSON.parse(captured.body.metadata.user_id).session_id,
    "string",
  );
});

test("a Claude Code conversation binds session affinity", async () => {
  const fixture = inferenceFixture();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 200 });

  try {
    await handleInference(
      new Request("https://gateway.example/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "model",
          messages: [],
          metadata: {
            user_id: JSON.stringify({
              device_id: "device-1",
              session_id: "claude-session",
            }),
          },
        }),
      }),
      fixture.env,
      fixture.config,
      fixture.client,
      "messages",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Regression: sessionIdForInference only read the Codex client_metadata, so
  // every Anthropic request resolved no session and skipped affinity entirely.
  assert.equal(fixture.affinities.size, 1);
  const binding = [...fixture.affinities.values()][0];
  assert.equal(binding.service_id, "primary");
  assert.equal(binding.key_id, "primary-key");
});

test("claude code identity reaches count_tokens without adding metadata", async () => {
  const fixture = inferenceFixture();
  fixture.config.services[0].inject_claude_code_identity = true;
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    captured = {
      url: request.url,
      anthropicBeta: request.headers.get("anthropic-beta"),
      userAgent: request.headers.get("user-agent"),
      xApp: request.headers.get("x-app"),
      body: JSON.parse(await request.text()),
    };
    return new Response(null, { status: 200 });
  };

  try {
    const response = await handleInference(
      new Request("https://gateway.example/v1/messages/count_tokens", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({ model: "model", messages: [] }),
      }),
      fixture.env,
      fixture.config,
      fixture.client,
      "messages/count_tokens",
    );
    assert.equal(response.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(captured.anthropicBeta, "claude-code-20250219");
  assert.equal(captured.userAgent, "claude-cli/2.1.246 (external, sdk-cli)");
  assert.equal(captured.xApp, "cli");
  assert.equal(
    captured.body.system[0].text,
    "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
  );
  // count_tokens rejects unknown top-level fields, so metadata stays out.
  assert.equal(Object.hasOwn(captured.body, "metadata"), false);
});

test("a real claude-cli user agent is not downgraded to the pinned one", async () => {
  const fixture = inferenceFixture();
  fixture.config.services[0].inject_claude_code_identity = true;
  const originalFetch = globalThis.fetch;
  let userAgent;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    userAgent = request.headers.get("user-agent");
    return new Response(null, { status: 200 });
  };

  try {
    await handleInference(
      new Request("https://gateway.example/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "user-agent": "claude-cli/9.9.9 (external, sdk-cli)",
        },
        body: JSON.stringify({ model: "model", messages: [] }),
      }),
      fixture.env,
      fixture.config,
      fixture.client,
      "messages",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(userAgent, "claude-cli/9.9.9 (external, sdk-cli)");
});

test("injected claude code identity is stable across requests", async () => {
  const fixture = inferenceFixture();
  fixture.config.services[0].inject_claude_code_identity = true;
  const originalFetch = globalThis.fetch;
  const userIds = [];
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body = JSON.parse(await request.text());
    userIds.push(JSON.parse(body.metadata.user_id));
    return new Response(null, { status: 200 });
  };

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await handleInference(
        new Request("https://gateway.example/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "anthropic-version": "2023-06-01",
            "session-id": "session-a",
          },
          body: JSON.stringify({ model: "model", messages: [] }),
        }),
        fixture.env,
        fixture.config,
        fixture.client,
        "messages",
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(userIds.length, 2);
  // Regression: random UUIDs per request made the upstream see a new device and
  // a new session on every turn of the same conversation.
  assert.deepEqual(userIds[0], userIds[1]);
  assert.match(
    userIds[0].device_id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

test("claude code identity is not injected when the service flag is off", async () => {
  const fixture = inferenceFixture();
  const originalFetch = globalThis.fetch;
  let capturedBody;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    capturedBody = await request.text();
    return new Response(null, { status: 200 });
  };

  try {
    const response = await handleInference(
      new Request("https://gateway.example/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "model", messages: [], system: "hi" }),
      }),
      fixture.env,
      fixture.config,
      fixture.client,
      "messages",
    );
    assert.equal(response.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(
    capturedBody,
    JSON.stringify({ model: "model", messages: [], system: "hi" }),
  );
});

test("claude code identity is not injected for OpenAI bodies", async () => {
  const fixture = inferenceFixture();
  fixture.config.services[0].inject_claude_code_identity = true;
  const originalFetch = globalThis.fetch;
  let capturedBody;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    capturedBody = await request.text();
    return new Response(null, { status: 200 });
  };

  try {
    const response = await handleInference(
      new Request("https://gateway.example/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "model",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      fixture.env,
      fixture.config,
      fixture.client,
      "chat/completions",
    );
    assert.equal(response.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(
    capturedBody,
    JSON.stringify({
      model: "model",
      messages: [{ role: "user", content: "hi" }],
    }),
  );
});

test("forwarding removes proxy metadata and client credentials", () => {
  const request = new Request("https://gateway.example/v1/responses", {
    headers: {
      authorization: "Bearer client",
      cookie: "session=secret",
      forwarded: "for=127.0.0.1",
      "x-forwarded-for": "127.0.0.1",
      "x-real-ip": "198.51.100.99",
      "cf-connecting-ip": "203.0.113.7",
      "x-api-key": "client",
      "x-openai-actor-authorization": "cody",
      "x-oai-attestation": "device-attestation",
      "chatgpt-account-id": "account-id",
      "content-length": "10",
      "x-tenant": "tenant-a",
      "content-type": "application/json",
    },
  });
  const headers = forwardRequestHeaders(request, "upstream");
  assert.equal(headers.get("authorization"), "Bearer upstream");
  assert.equal(headers.get("cookie"), null);
  assert.equal(headers.get("forwarded"), null);
  assert.equal(headers.get("x-forwarded-for"), null);
  assert.equal(headers.get("x-real-ip"), null);
  assert.equal(headers.get("cf-connecting-ip"), null);
  assert.equal(headers.get("x-api-key"), null);
  assert.equal(headers.get("x-openai-actor-authorization"), null);
  assert.equal(headers.get("x-oai-attestation"), null);
  assert.equal(headers.get("chatgpt-account-id"), null);
  assert.equal(headers.get("content-length"), null);
  assert.equal(headers.get("x-tenant"), "tenant-a");
  assert.equal(headers.get("content-type"), "application/json");
});

test("Anthropic forwarding sends a bearer token and drops the client x-api-key", () => {
  const request = new Request("https://gateway.example/v1/messages", {
    headers: {
      "x-api-key": "client",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "messages-2025-04-14",
      "x-tenant": "tenant-a",
    },
  });
  const headers = forwardRequestHeaders(request, "upstream");
  assert.equal(headers.get("authorization"), "Bearer upstream");
  assert.equal(headers.get("x-api-key"), null);
  assert.equal(headers.get("anthropic-version"), "2023-06-01");
  assert.equal(headers.get("anthropic-beta"), "messages-2025-04-14");
  assert.equal(headers.get("x-tenant"), "tenant-a");
});

test("Anthropic bearer forwarding replaces the bearer token", () => {
  const request = new Request("https://gateway.example/v1/messages", {
    headers: {
      authorization: "Bearer client-oauth",
      "anthropic-version": "2023-06-01",
    },
  });
  const headers = forwardRequestHeaders(request, "upstream-oauth");
  assert.equal(headers.get("authorization"), "Bearer upstream-oauth");
  assert.equal(headers.get("x-api-key"), null);
});

test("anthropicErrorType maps statuses to the documented Anthropic types", () => {
  assert.equal(anthropicErrorType(400), "invalid_request_error");
  assert.equal(anthropicErrorType(401), "authentication_error");
  assert.equal(anthropicErrorType(403), "permission_error");
  assert.equal(anthropicErrorType(404), "not_found_error");
  assert.equal(anthropicErrorType(413), "request_too_large");
  assert.equal(anthropicErrorType(429), "rate_limit_error");
  assert.equal(anthropicErrorType(503), "overloaded_error");
  assert.equal(anthropicErrorType(529), "overloaded_error");
  // Statuses without a documented type fall back to api_error rather than an
  // invented one such as server_error.
  assert.equal(anthropicErrorType(500), "api_error");
  assert.equal(anthropicErrorType(502), "api_error");
});

test("apiError emits Anthropic types and keeps OpenAI codes", async () => {
  const anthropic = apiError("anthropic", 503, "cooling down", {
    type: "server_error",
    code: "service_cooling_down",
    requestId: "req-1",
  });
  assert.equal(anthropic.status, 503);
  assert.deepEqual(await anthropic.json(), {
    type: "error",
    request_id: "req-1",
    error: { type: "overloaded_error", message: "cooling down" },
  });

  const openai = apiError("openai", 503, "cooling down", {
    type: "server_error",
    code: "service_cooling_down",
    requestId: "req-1",
  });
  assert.deepEqual(await openai.json(), {
    error: {
      message: "cooling down",
      type: "server_error",
      param: null,
      code: "service_cooling_down",
    },
  });
});

test("a Claude client catalog request still authenticates with a bearer token", () => {
  // Regression: /v1/models fans out to every allowed service regardless of
  // protocol, so mirroring only the client's x-api-key left OpenAI-compatible
  // upstreams unauthenticated and cooled their key health down.
  const request = new Request("https://gateway.example/v1/models", {
    headers: {
      "x-api-key": "client",
      "anthropic-version": "2023-06-01",
      "user-agent": "claude-cli/2.1.246 (external, sdk-cli)",
    },
  });
  const headers = forwardRequestHeaders(request, "upstream-secret");
  assert.equal(headers.get("authorization"), "Bearer upstream-secret");
  assert.equal(headers.get("x-api-key"), null);
});

test("WebSocket forwarding strips Codex credentials and attestation", () => {
  const request = new Request("https://gateway.example/v1/responses", {
    headers: {
      "x-openai-actor-authorization": "cody",
      "x-oai-attestation": "device-attestation",
      "chatgpt-account-id": "account-id",
      "x-tenant": "tenant-a",
    },
  });
  const headers = forwardWebSocketHeaders(request, "upstream");
  assert.equal(headers.get("x-openai-actor-authorization"), null);
  assert.equal(headers.get("x-oai-attestation"), null);
  assert.equal(headers.get("chatgpt-account-id"), null);
  assert.equal(headers.get("x-tenant"), "tenant-a");
});

test("forwarding strips a client-supplied X-Real-IP", () => {
  const request = new Request("https://gateway.example/v1/responses", {
    headers: { "x-real-ip": "198.51.100.99" },
  });
  const headers = forwardRequestHeaders(request, "upstream");
  assert.equal(headers.get("x-real-ip"), null);
});

test("client API keys are selected through the asynchronous secret comparison", async () => {
  const entries = [
    { id: "first-client", api_key: "first-key", services: ["first"] },
    { id: "matching-client", api_key: "matching-key", services: ["second"] },
  ];
  const match = await findClientApiKey(
    new Request("https://gateway.example", {
      headers: { authorization: "Bearer matching-key" },
    }),
    entries,
  );
  const missing = await findClientApiKey(
    new Request("https://gateway.example", {
      headers: { authorization: "Bearer missing-key" },
    }),
    entries,
  );

  assert.equal(match, entries[1]);
  assert.equal(missing, undefined);
});

test("client API keys are selected from x-api-key as well as bearer tokens", async () => {
  const entries = [
    { id: "first-client", api_key: "first-key", services: ["first"] },
    { id: "claude-client", api_key: "claude-key", services: ["second"] },
  ];
  const match = await findClientApiKey(
    new Request("https://gateway.example/v1/messages", {
      headers: { "x-api-key": "claude-key" },
    }),
    entries,
  );
  assert.equal(match, entries[1]);
  assert.deepEqual(
    requestCredentialTokens(
      new Request("https://gateway.example/v1/messages", {
        headers: {
          authorization: "Bearer bearer-token",
          "x-api-key": "api-key-token",
        },
      }),
    ),
    ["bearer-token", "api-key-token"],
  );
});

test("inference HTTP health only records 400 and 503 responses", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const [status, expectedFailures] of [
      [400, 1],
      [503, 1],
      [429, 0],
      [500, 0],
    ]) {
      const fixture = inferenceFixture();
      globalThis.fetch = async () => new Response(null, { status });
      const response = await handleInference(
        inferenceRequest(),
        fixture.env,
        fixture.config,
        fixture.client,
        "responses",
        "health-test",
        undefined,
        { wait: async () => {} },
      );
      assert.equal(response.status, status);
      assert.equal(fixture.calls.failure, expectedFailures);
      assert.equal(fixture.calls.keyFailure, 0);
      assert.equal(fixture.calls.success, 0);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("inference immediately cools the selected key on HTTP 402 or 403", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const status of [402, 403]) {
      const fixture = inferenceFixture();
      globalThis.fetch = async () => new Response(null, { status });
      const response = await handleInference(
        inferenceRequest(),
        fixture.env,
        fixture.config,
        fixture.client,
        "responses",
        `key-health-${status}`,
      );
      assert.equal(response.status, status);
      assert.equal(fixture.calls.keyFailure, 1);
      assert.equal(fixture.calls.failure, 0);
      assert.equal(fixture.calls.success, 0);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Anthropic inference cools the key on 401 and records service failure on 529", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const [status, expectedKeyFailures, expectedFailures] of [
      [401, 1, 0],
      [529, 0, 1],
    ]) {
      const fixture = inferenceFixture();
      globalThis.fetch = async () => new Response(null, { status });
      const response = await handleInference(
        new Request("https://gateway.example/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": "client",
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({ model: "model", messages: [] }),
        }),
        fixture.env,
        fixture.config,
        fixture.client,
        "messages",
        `anthropic-health-${status}`,
      );
      assert.equal(response.status, status);
      assert.equal(fixture.calls.keyFailure, expectedKeyFailures);
      assert.equal(fixture.calls.failure, expectedFailures);
      assert.equal(fixture.calls.success, 0);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("health classification follows the request dialect, not the endpoint host", async () => {
  // One service may serve both dialects, so the dialect comes from the request.
  // 500 is an Anthropic service failure but not an OpenAI one; 400 is the
  // reverse. The same service config is used for both rows.
  const originalFetch = globalThis.fetch;
  try {
    for (const [path, upstreamPath, status, expectedFailures] of [
      ["/v1/messages", "messages", 500, 1],
      ["/v1/messages", "messages", 400, 0],
      ["/v1/responses", "responses", 500, 0],
      ["/v1/responses", "responses", 400, 1],
    ]) {
      const fixture = inferenceFixture();
      globalThis.fetch = async () => new Response(null, { status });
      const body =
        upstreamPath === "messages"
          ? { model: "model", messages: [] }
          : { model: "model", input: "hello" };
      const response = await handleInference(
        new Request(`https://gateway.example${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        fixture.env,
        fixture.config,
        fixture.client,
        upstreamPath,
        `dialect-${upstreamPath}-${status}`,
      );
      assert.equal(response.status, status);
      assert.equal(
        fixture.calls.failure,
        expectedFailures,
        `${upstreamPath} returning ${status}`,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a retrying 403 cools the key even when the same-key retry succeeds", async () => {
  const fixture = inferenceFixture({ status_codes: [403], delays_ms: [0] });
  const originalFetch = globalThis.fetch;
  const authorizations = [];
  let attempts = 0;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    authorizations.push(request.headers.get("authorization"));
    attempts += 1;
    return new Response(null, { status: attempts === 1 ? 403 : 200 });
  };

  try {
    const response = await handleInference(
      inferenceRequest(),
      fixture.env,
      fixture.config,
      fixture.client,
      "responses",
      "retry-key-cooldown",
      undefined,
      { wait: async () => {} },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(authorizations, [
      "Bearer service-secret-key",
      "Bearer service-secret-key",
    ]);
    assert.equal(fixture.calls.keyFailure, 1);
    assert.equal(fixture.calls.success, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a cooled key affects only the next request, which may select another key", async () => {
  const fixture = inferenceFixture();
  const originalFetch = globalThis.fetch;
  const authorizations = [];
  let attempts = 0;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    authorizations.push(request.headers.get("authorization"));
    attempts += 1;
    return new Response(null, { status: attempts === 1 ? 403 : 200 });
  };

  try {
    const first = await handleInference(
      inferenceRequest(),
      fixture.env,
      fixture.config,
      fixture.client,
      "responses",
    );
    const second = await handleInference(
      inferenceRequest(),
      fixture.env,
      fixture.config,
      fixture.client,
      "responses",
    );
    assert.equal(first.status, 403);
    assert.equal(second.status, 200);
    assert.deepEqual(authorizations, [
      "Bearer service-secret-key",
      "Bearer service-backup-key",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("inference retries configured HTTP statuses with the same request", async () => {
  const retry = {
    status_codes: [429],
    delays_ms: [250, 500, 1_000],
  };
  const fixture = inferenceFixture(retry);
  const originalFetch = globalThis.fetch;
  const waits = [];
  const requests = [];
  let attempts = 0;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push({
      url: request.url,
      method: request.method,
      authorization: request.headers.get("authorization"),
      body: await request.text(),
    });
    attempts += 1;
    return attempts < 4
      ? new Response(`rate limited ${attempts}`, { status: 429 })
      : new Response("event: response.completed\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
  };

  try {
    const response = await handleInference(
      inferenceRequest(),
      fixture.env,
      fixture.config,
      fixture.client,
      "responses",
      "retry-test",
      undefined,
      { wait: async (delayMs) => waits.push(delayMs) },
    );

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "event: response.completed\n\n");
    assert.deepEqual(waits, retry.delays_ms);
    assert.equal(requests.length, 4);
    assert(
      requests.every(
        (request) => request.url === "https://primary.example/v1/responses",
      ),
    );
    assert(requests.every((request) => request.method === "POST"));
    assert(
      requests.every(
        (request) => request.authorization === "Bearer service-secret-key",
      ),
    );
    const expectedBody = JSON.stringify({ model: "model", input: "hello" });
    assert(requests.every((request) => request.body === expectedBody));
    assert.equal(fixture.calls.failure, 0);
    assert.equal(fixture.calls.success, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("inference uses the next configured key only after a manual configuration change", async () => {
  const fixture = inferenceFixture();
  fixture.config.services[0].keys[0].disabled = true;
  const originalFetch = globalThis.fetch;
  let authorization;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    authorization = request.headers.get("authorization");
    return new Response(null, { status: 200 });
  };

  try {
    const response = await handleInference(
      inferenceRequest(),
      fixture.env,
      fixture.config,
      fixture.client,
      "responses",
    );
    assert.equal(response.status, 200);
    assert.equal(authorization, "Bearer service-backup-key");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("inference does not fall back to another key after an upstream response", async () => {
  const fixture = inferenceFixture();
  const originalFetch = globalThis.fetch;
  const authorizations = [];
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    authorizations.push(request.headers.get("authorization"));
    return new Response(null, { status: 503 });
  };

  try {
    const response = await handleInference(
      inferenceRequest(),
      fixture.env,
      fixture.config,
      fixture.client,
      "responses",
    );
    assert.equal(response.status, 503);
    assert.deepEqual(authorizations, ["Bearer service-secret-key"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("inference does not retry HTTP 429 when the service has no retry policy", async () => {
  const fixture = inferenceFixture();
  const originalFetch = globalThis.fetch;
  const waits = [];
  let attempts = 0;
  const upstreamResponse = new Response("rate limited", { status: 429 });
  globalThis.fetch = async () => {
    attempts += 1;
    return upstreamResponse;
  };

  try {
    const response = await handleInference(
      inferenceRequest(),
      fixture.env,
      fixture.config,
      fixture.client,
      "responses",
      "no-retry-test",
      undefined,
      { wait: async (delayMs) => waits.push(delayMs) },
    );

    assert.equal(response, upstreamResponse);
    assert.equal(attempts, 1);
    assert.deepEqual(waits, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("inference can retry a different status for a different service policy", async () => {
  const retry = {
    status_codes: [503],
    delays_ms: [100, 300],
  };
  const fixture = inferenceFixture(retry);
  const originalFetch = globalThis.fetch;
  const waits = [];
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return new Response(null, { status: attempts < 3 ? 503 : 200 });
  };

  try {
    const response = await handleInference(
      inferenceRequest(),
      fixture.env,
      fixture.config,
      fixture.client,
      "responses",
      "custom-retry-test",
      undefined,
      { wait: async (delayMs) => waits.push(delayMs) },
    );

    assert.equal(response.status, 200);
    assert.equal(attempts, 3);
    assert.deepEqual(waits, retry.delays_ms);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("inference returns the final HTTP 429 unchanged after exhausting retries", async () => {
  const retry = {
    status_codes: [429],
    delays_ms: [250, 500, 1_000],
  };
  const fixture = inferenceFixture(retry);
  const originalFetch = globalThis.fetch;
  const waits = [];
  let attempts = 0;
  let cancelledBodies = 0;
  const finalResponse = new Response('{"error":"still rate limited"}', {
    status: 429,
    headers: {
      "content-type": "application/json",
      "retry-after": "9",
      "x-upstream-marker": "final",
    },
  });
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 4) {
      return finalResponse;
    }
    return new Response(
      new ReadableStream({
        cancel() {
          cancelledBodies += 1;
        },
      }),
      { status: 429 },
    );
  };

  try {
    const response = await handleInference(
      inferenceRequest(),
      fixture.env,
      fixture.config,
      fixture.client,
      "responses",
      "retry-exhausted-test",
      undefined,
      { wait: async (delayMs) => waits.push(delayMs) },
    );

    assert.equal(response, finalResponse);
    assert.equal(attempts, 4);
    assert.equal(cancelledBodies, 3);
    assert.deepEqual(waits, retry.delays_ms);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "9");
    assert.equal(response.headers.get("x-upstream-marker"), "final");
    assert.equal(await response.text(), '{"error":"still rate limited"}');
    assert.equal(fixture.calls.failure, 0);
    assert.equal(fixture.calls.success, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("inference network exceptions continue to record a health failure", async () => {
  const fixture = inferenceFixture();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network unavailable");
  };

  try {
    const response = await handleInference(
      inferenceRequest(),
      fixture.env,
      fixture.config,
      fixture.client,
      "responses",
    );
    assert.equal(response.status, 502);
    assert.equal(fixture.calls.failure, 1);
    assert.equal(fixture.calls.success, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
