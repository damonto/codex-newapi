import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveStoredAffinity,
  SESSION_AFFINITY_TTL_MS,
  sessionAffinityIdentity,
} from "../src/affinity.ts";
import { clearConfigCacheForTests } from "../src/config.ts";
import {
  FAILURE_THRESHOLD,
  keyIsAvailable,
  ServiceHealthState,
  serviceIsAvailable,
} from "../src/health.ts";
import worker from "../src/index.ts";
import { clearModelsCacheForTests } from "../src/models.ts";

function gatewayConfig() {
  return {
    services: [
      {
        id: "primary",
        base_url: "https://primary.example/v1",
        keys: [
          {
            id: "primary-key",
            api_key: "upstream-key",
            disabled: false,
            priority: 100,
          },
          {
            id: "backup-key",
            api_key: "upstream-backup-key",
            disabled: true,
            priority: 50,
          },
        ],
        disabled: false,
        priority: 100,
        supports_websocket: true,
        supports_web_search: true,
        models: ["grok-4.5", "review-model"],
      },
    ],
    api_keys: [
      { id: "gateway-client", api_key: "client-key", services: ["primary"] },
    ],
    model_routes: {
      "gpt-5.6-sol": { model: "grok-4.5" },
      "codex-auto-review": { model: "review-model", services: ["primary"] },
    },
  };
}

function testEnv(config) {
  const healthObjects = new Map();
  const affinities = new Map();
  const sessionIndexes = new Map();
  const sessionIndex = (name) => {
    if (!sessionIndexes.has(name)) {
      sessionIndexes.set(name, new Map());
    }
    return sessionIndexes.get(name);
  };
  const removeIndexEntry = (record) => {
    if (
      !record?.registry_name ||
      !record.session_digest ||
      !record.binding_id
    ) {
      return false;
    }
    const index = sessionIndex(record.registry_name);
    const current = index.get(record.session_digest);
    if (
      current?.binding_id !== record.binding_id ||
      current.generation !== record.generation
    ) {
      return false;
    }
    return index.delete(record.session_digest);
  };
  return {
    CODY_CONFIG_KV: {
      get: async () => JSON.stringify(config),
    },
    HEALTH: {
      getByName: (name) => {
        if (!healthObjects.has(name)) {
          healthObjects.set(name, new ServiceHealthState());
        }
        return healthObjects.get(name);
      },
    },
    SESSION_AFFINITY: {
      getByName: (name) => ({
        resolve: async (candidates, preferred, registration) => {
          const stored = affinities.get(name);
          if (stored) {
            const decision = resolveStoredAffinity(
              stored,
              candidates,
              preferred,
              () => 0,
            );
            if (!decision.selection) {
              affinities.delete(name);
              removeIndexEntry(stored);
              return undefined;
            }
            const now = Date.now();
            const next = {
              ...stored,
              ...decision.selection,
              updated_at: now,
            };
            if (decision.status === "rebound" && stored.binding_id) {
              next.binding_id = crypto.randomUUID();
              next.created_at = now;
              next.generation = stored.generation + 1;
              next.index_registered = true;
              removeIndexEntry(stored);
              sessionIndex(stored.registry_name).set(stored.session_digest, {
                session_digest: stored.session_digest,
                session_id: stored.session_id,
                binding_id: next.binding_id,
                created_at: next.created_at,
                generation: next.generation,
              });
            }
            affinities.set(name, next);
            return { ...next, status: decision.status };
          }
          if (!preferred) {
            affinities.delete(name);
            return undefined;
          }
          if (!registration) {
            throw new Error("session affinity registration is required");
          }
          const now = Date.now();
          const next = {
            ...preferred,
            updated_at: now,
            binding_id: crypto.randomUUID(),
            created_at: now,
            generation: 1,
            registry_name: registration.registry_name,
            session_digest: registration.session_digest,
            session_id: registration.session_id,
            index_registered: true,
          };
          affinities.set(name, next);
          sessionIndex(registration.registry_name).set(
            registration.session_digest,
            {
              session_digest: registration.session_digest,
              session_id: registration.session_id,
              binding_id: next.binding_id,
              created_at: now,
              generation: next.generation,
            },
          );
          return { ...next, status: "created" };
        },
        getStatus: async () => {
          const stored = affinities.get(name);
          return stored &&
            stored.updated_at + SESSION_AFFINITY_TTL_MS > Date.now()
            ? stored
            : null;
        },
        clearIfBindingId: async (bindingId, generation) => {
          const stored = affinities.get(name);
          if (
            !stored ||
            stored.binding_id !== bindingId ||
            stored.generation !== generation
          ) {
            return false;
          }
          affinities.delete(name);
          return true;
        },
        clearManaged: async (registration) => {
          const stored = affinities.get(name);
          if (
            !stored ||
            stored.binding_id === undefined ||
            stored.registry_name !== registration.registry_name ||
            stored.session_digest !== registration.session_digest ||
            stored.session_id !== registration.session_id
          ) {
            return null;
          }
          affinities.delete(name);
          return {
            binding_id: stored.binding_id,
            generation: stored.generation,
          };
        },
      }),
    },
    SESSION_AFFINITY_INDEX: {
      getByName: (name) => ({
        register: async (entry) => {
          const index = sessionIndex(name);
          const current = index.get(entry.session_digest);
          if (
            current &&
            (entry.generation < current.generation ||
              (entry.generation === current.generation &&
                entry.binding_id !== current.binding_id))
          )
            return current;
          index.set(entry.session_digest, { ...entry });
          const registered = index.get(entry.session_digest);
          if (!registered) {
            throw new Error("session affinity index write was not persisted");
          }
          return registered;
        },
        get: async (sessionDigest) =>
          sessionIndex(name).get(sessionDigest) ?? null,
        listPage: async (cursor, limit) => {
          const rows = [...sessionIndex(name).values()]
            .filter((entry) => cursor === null || entry.session_digest > cursor)
            .sort((left, right) =>
              left.session_digest.localeCompare(right.session_digest),
            );
          const data = rows.slice(0, limit);
          let nextCursor = null;
          if (rows.length > limit) {
            const lastEntry = data[data.length - 1];
            if (!lastEntry) {
              throw new Error(
                "session affinity index page is unexpectedly empty",
              );
            }
            nextCursor = lastEntry.session_digest;
          }
          return {
            data,
            next_cursor: nextCursor,
          };
        },
        remove: async (sessionDigest, bindingId, generation) => {
          const index = sessionIndex(name);
          const current = index.get(sessionDigest);
          if (
            current?.binding_id !== bindingId ||
            current.generation !== generation
          ) {
            return false;
          }
          return index.delete(sessionDigest);
        },
      }),
    },
    CONFIG_KEY: "gateway-config",
    CONFIG_CACHE_TTL_SECONDS: "0",
  };
}

async function captureLogs(run) {
  const original = {
    error: console.error,
    info: console.info,
    log: console.log,
    warn: console.warn,
  };
  const lines = [];
  const entries = [];
  for (const level of ["error", "info", "log", "warn"]) {
    console[level] = (...args) => {
      const entry =
        args.length === 1 && typeof args[0] === "object" && args[0] !== null
          ? args[0]
          : JSON.parse(args.map(String).join(" "));
      entries.push(entry);
      lines.push(JSON.stringify(entry));
    };
  }
  try {
    const value = await run();
    return {
      value,
      lines,
      entries,
    };
  } finally {
    console.error = original.error;
    console.info = original.info;
    console.log = original.log;
    console.warn = original.warn;
  }
}

function trackedExecutionContext() {
  const pending = [];
  return {
    context: {
      waitUntil(promise) {
        pending.push(promise);
      },
    },
    async drain() {
      await Promise.all(pending);
    },
  };
}

test("Worker maps the model, replaces authorization, and preserves the upstream response", async () => {
  clearConfigCacheForTests();
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    captured = {
      url: request.url,
      authorization: request.headers.get("authorization"),
      contentMd5: request.headers.get("content-md5"),
      body: JSON.parse(await request.text()),
    };
    return new Response("upstream-stream", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  try {
    const response = await worker.fetch(
      new Request("https://gateway.example/v1/responses?trace=yes", {
        method: "POST",
        headers: {
          authorization: "Bearer client-key",
          "content-type": "application/json",
          "content-md5": "stale-digest",
        },
        body: JSON.stringify({
          model: "gpt-5.6-sol",
          stream: true,
          input: "hello",
        }),
      }),
      testEnv(gatewayConfig()),
      {},
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.equal(await response.text(), "upstream-stream");
    assert.deepEqual(captured, {
      url: "https://primary.example/v1/responses?trace=yes",
      authorization: "Bearer upstream-key",
      contentMd5: null,
      body: { model: "grok-4.5", stream: true, input: "hello" },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Worker forwards Claude Code messages with a bearer token", async () => {
  clearConfigCacheForTests();
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    captured = {
      url: request.url,
      xApiKey: request.headers.get("x-api-key"),
      authorization: request.headers.get("authorization"),
      anthropicVersion: request.headers.get("anthropic-version"),
      body: JSON.parse(await request.text()),
    };
    return new Response("event: message_start\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  try {
    const response = await worker.fetch(
      new Request("https://gateway.example/v1/messages?beta=true", {
        method: "POST",
        headers: {
          "x-api-key": "client-key",
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "grok-4.5",
          max_tokens: 1024,
          messages: [{ role: "user", content: "hello" }],
          stream: true,
        }),
      }),
      testEnv(gatewayConfig()),
      {},
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.equal(await response.text(), "event: message_start\n\n");
    assert.deepEqual(captured, {
      url: "https://primary.example/v1/messages?beta=true",
      xApiKey: null,
      authorization: "Bearer upstream-key",
      anthropicVersion: "2023-06-01",
      body: {
        model: "grok-4.5",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Worker returns Anthropic-shaped authentication errors to Claude clients", async () => {
  clearConfigCacheForTests();
  const response = await worker.fetch(
    new Request("https://gateway.example/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": "wrong-key",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: "grok-4.5", messages: [] }),
    }),
    testEnv(gatewayConfig()),
    {},
  );
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.type, "error");
  assert.deepEqual(body.error, {
    type: "authentication_error",
    message: "Invalid API key",
  });
  assert.equal(typeof body.request_id, "string");
  assert.equal(body.request_id.length > 0, true);
});

test("Worker keeps the OpenAI invalid_api_key code for bearer clients", async () => {
  clearConfigCacheForTests();
  const response = await worker.fetch(
    new Request("https://gateway.example/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer wrong-key" },
      body: JSON.stringify({ model: "grok-4.5", input: "hello" }),
    }),
    testEnv(gatewayConfig()),
    {},
  );
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    error: {
      message: "Invalid API key",
      type: "invalid_request_error",
      param: null,
      code: "invalid_api_key",
    },
  });
});

test("Worker forwards alpha search and responses compact aliases with response fidelity", async () => {
  clearConfigCacheForTests();
  const originalFetch = globalThis.fetch;
  const captured = [];
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    captured.push({
      url: request.url,
      authorization: request.headers.get("authorization"),
      tenant: request.headers.get("x-tenant"),
      body: JSON.parse(await request.text()),
    });
    return new Response("upstream-body", {
      status: 202,
      headers: {
        "content-type": "application/json",
        "x-upstream-marker": "preserved",
      },
    });
  };

  const paths = [
    "/alpha/search",
    "/v1/alpha/search",
    "/responses/compact",
    "/v1/responses/compact",
  ];
  try {
    const env = testEnv(gatewayConfig());
    for (const path of paths) {
      const response = await worker.fetch(
        new Request(
          `https://gateway.example${path}?trace=${encodeURIComponent(path)}`,
          {
            method: "POST",
            headers: {
              authorization: "Bearer client-key",
              "content-type": "application/json",
              "x-tenant": "tenant-a",
            },
            body: JSON.stringify({
              model: "gpt-5.6-sol",
              id: "search-session",
              input: "hello",
            }),
          },
        ),
        env,
        {},
      );
      assert.equal(response.status, 202);
      assert.equal(response.headers.get("x-upstream-marker"), "preserved");
      assert.equal(await response.text(), "upstream-body");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(
    captured.map((entry) => ({
      ...entry,
      url: new URL(entry.url).pathname,
      search: new URL(entry.url).search,
    })),
    [
      {
        url: "/v1/alpha/search",
        search: "?trace=%2Falpha%2Fsearch",
        authorization: "Bearer upstream-key",
        tenant: "tenant-a",
        body: { model: "grok-4.5", id: "search-session", input: "hello" },
      },
      {
        url: "/v1/alpha/search",
        search: "?trace=%2Fv1%2Falpha%2Fsearch",
        authorization: "Bearer upstream-key",
        tenant: "tenant-a",
        body: { model: "grok-4.5", id: "search-session", input: "hello" },
      },
      {
        url: "/v1/responses/compact",
        search: "?trace=%2Fresponses%2Fcompact",
        authorization: "Bearer upstream-key",
        tenant: "tenant-a",
        body: { model: "grok-4.5", id: "search-session", input: "hello" },
      },
      {
        url: "/v1/responses/compact",
        search: "?trace=%2Fv1%2Fresponses%2Fcompact",
        authorization: "Bearer upstream-key",
        tenant: "tenant-a",
        body: { model: "grok-4.5", id: "search-session", input: "hello" },
      },
    ],
  );
});

test("alpha search skips higher-priority services without web search support", async () => {
  clearConfigCacheForTests();
  const config = gatewayConfig();
  config.services[0].supports_web_search = false;
  config.services.push({
    id: "search",
    base_url: "https://search.example/v1",
    keys: [
      {
        id: "search-key",
        api_key: "search-upstream-key",
        disabled: false,
        priority: 100,
      },
    ],
    disabled: false,
    priority: 50,
    supports_websocket: false,
    supports_web_search: true,
    models: ["grok-4.5"],
  });
  config.api_keys[0].services.push("search");
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    captured = {
      url: request.url,
      authorization: request.headers.get("authorization"),
    };
    return new Response(null, { status: 200 });
  };

  try {
    const response = await worker.fetch(
      new Request("https://gateway.example/v1/alpha/search", {
        method: "POST",
        headers: {
          authorization: "Bearer client-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello" }),
      }),
      testEnv(config),
      {},
    );
    assert.equal(response.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(captured, {
    url: "https://search.example/v1/alpha/search",
    authorization: "Bearer search-upstream-key",
  });
});

test("alpha search does not forward when no service declares web search support", async () => {
  clearConfigCacheForTests();
  const config = gatewayConfig();
  config.services[0].supports_web_search = false;
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(null, { status: 200 });
  };

  try {
    const response = await worker.fetch(
      new Request("https://gateway.example/v1/alpha/search", {
        method: "POST",
        headers: {
          authorization: "Bearer client-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello" }),
      }),
      testEnv(config),
      {},
    );
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "model_not_found");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls, 0);
});

test("configured Tavily search returns a provider 404 without upstream fallback", async () => {
  clearConfigCacheForTests();
  const config = gatewayConfig();
  config.web_search = {
    mode: "tavily",
    base_url: "https://tavily.example",
    api_key: "tavily-key",
    max_results: 4,
  };
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    urls.push(request.url);
    return Response.json({ detail: { error: "not found" } }, { status: 404 });
  };

  try {
    const response = await worker.fetch(
      new Request("https://gateway.example/v1/alpha/search", {
        method: "POST",
        headers: {
          authorization: "Bearer client-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-5.6-sol",
          commands: { search_query: [{ q: "docs" }] },
        }),
      }),
      testEnv(config),
      {},
    );
    assert.equal(response.status, 404);
    assert.equal(
      (await response.json()).error.code,
      "web_search_upstream_error",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(urls, ["https://tavily.example/search"]);
});

test("new HTTP forwarding endpoints accept POST only", async () => {
  clearConfigCacheForTests();
  const env = testEnv(gatewayConfig());
  for (const path of ["/alpha/search", "/v1/responses/compact"]) {
    const response = await worker.fetch(
      new Request(`https://gateway.example${path}`, {
        headers: { authorization: "Bearer client-key" },
      }),
      env,
      {},
    );
    assert.equal(response.status, 405);
  }
});

test("session-id header and client metadata share the same persistent binding", async () => {
  clearConfigCacheForTests();
  const config = gatewayConfig();
  config.services.push({
    id: "peer",
    base_url: "https://peer.example/v1",
    keys: [
      {
        id: "peer-key",
        api_key: "peer-upstream-key",
        disabled: false,
        priority: 100,
      },
    ],
    disabled: false,
    priority: 100,
    models: ["grok-4.5"],
  });
  config.api_keys[0].services.push("peer");
  const originalFetch = globalThis.fetch;
  const targets = [];
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    targets.push([request.url, request.headers.get("authorization")]);
    return new Response(null, { status: 200 });
  };

  try {
    const env = testEnv(config);
    const headerBound = await worker.fetch(
      new Request("https://gateway.example/v1/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer client-key",
          "content-type": "application/json",
          "session-id": "stable-session",
        },
        body: JSON.stringify({
          model: "gpt-5.6-sol",
          client_metadata: { session_id: "ignored-session" },
        }),
      }),
      env,
      {},
    );
    const metadataBound = await worker.fetch(
      new Request("https://gateway.example/v1/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer client-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-5.6-sol",
          client_metadata: { session_id: "stable-session" },
        }),
      }),
      env,
      {},
    );
    assert.equal(headerBound.status, 200);
    assert.equal(metadataBound.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(targets.length, 2);
  assert.deepEqual(targets[1], targets[0]);
});

test("Worker proxies Codex image generation and edits through model routing", async () => {
  clearConfigCacheForTests();
  const config = gatewayConfig();
  config.services[0].models.push("gpt-image-2");
  config.services[0].retry = { status_codes: [429], delays_ms: [0] };
  config.model_routes["image-client"] = { model: "gpt-image-2" };
  const originalFetch = globalThis.fetch;
  const captured = [];
  let generationAttempts = 0;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    captured.push({
      url: request.url,
      authorization: request.headers.get("authorization"),
      body: JSON.parse(await request.text()),
    });
    if (request.url.includes("/images/generations")) {
      generationAttempts += 1;
      if (generationAttempts === 1) {
        return new Response('{"error":"retry"}', { status: 429 });
      }
    }
    return new Response('{"data":[{"b64_json":"aW1hZ2U="}]}', {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-upstream-image": "yes",
      },
    });
  };

  try {
    const env = testEnv(config);
    const generation = await worker.fetch(
      new Request(
        "https://gateway.example/v1/images/generations?trace=generation",
        {
          method: "POST",
          headers: {
            authorization: "Bearer client-key",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "image-client",
            prompt: "a fox in a field",
            background: "auto",
            quality: "auto",
            size: "auto",
          }),
        },
      ),
      env,
      {},
    );
    assert.equal(generation.status, 200);
    assert.equal(generation.headers.get("x-upstream-image"), "yes");
    assert.equal(await generation.text(), '{"data":[{"b64_json":"aW1hZ2U="}]}');

    const edit = await worker.fetch(
      new Request("https://gateway.example/images/edits?trace=edit", {
        method: "POST",
        headers: {
          authorization: "Bearer client-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-image-2",
          prompt: "add a red hat",
          images: [{ image_url: "data:image/png;base64,aW1hZ2U=" }],
          background: "auto",
          quality: "auto",
          size: "auto",
        }),
      }),
      env,
      {},
    );
    assert.equal(edit.status, 200);
    assert.equal(edit.headers.get("x-upstream-image"), "yes");
    assert.equal(await edit.text(), '{"data":[{"b64_json":"aW1hZ2U="}]}');
  } finally {
    globalThis.fetch = originalFetch;
  }

  const generationBody = {
    model: "gpt-image-2",
    prompt: "a fox in a field",
    background: "auto",
    quality: "auto",
    size: "auto",
  };
  assert.deepEqual(captured, [
    {
      url: "https://primary.example/v1/images/generations?trace=generation",
      authorization: "Bearer upstream-key",
      body: generationBody,
    },
    {
      url: "https://primary.example/v1/images/generations?trace=generation",
      authorization: "Bearer upstream-key",
      body: generationBody,
    },
    {
      url: "https://primary.example/v1/images/edits?trace=edit",
      authorization: "Bearer upstream-key",
      body: {
        model: "gpt-image-2",
        prompt: "add a red hat",
        images: [{ image_url: "data:image/png;base64,aW1hZ2U=" }],
        background: "auto",
        quality: "auto",
        size: "auto",
      },
    },
  ]);
});

test("Image API requests reject unavailable models before contacting an upstream service", async () => {
  clearConfigCacheForTests();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(null, { status: 200 });
  };

  try {
    const response = await worker.fetch(
      new Request("https://gateway.example/v1/images/generations", {
        method: "POST",
        headers: {
          authorization: "Bearer client-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "gpt-image-2", prompt: "draw a fox" }),
      }),
      testEnv(gatewayConfig()),
      {},
    );
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "model_not_found");
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("gateway logs correlate a request without logging credentials or body content", async () => {
  clearConfigCacheForTests();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("ok", { status: 200 });

  let captured;
  try {
    captured = await captureLogs(async () => {
      const response = await worker.fetch(
        new Request("https://gateway.example/v1/responses", {
          method: "POST",
          headers: {
            authorization: "Bearer client-key",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-5.6-sol",
            input: "secret-request-body",
          }),
        }),
        testEnv(gatewayConfig()),
        {},
      );
      assert.equal(response.status, 200);
      return response;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(captured.entries.length, 1);
  const [entry] = captured.entries;
  assert.equal(entry.event, "request.summary");
  assert.equal(entry.method, "POST");
  assert.equal(entry.path, "/v1/responses");
  assert.equal(entry.response_status, 200);
  assert.equal(entry.outcome, "success");
  assert.equal(entry.client_key_id, "gateway-client");
  assert.deepEqual(entry.routing.candidate_services, ["primary"]);
  assert.deepEqual(entry.routing.checked_available_services, ["primary"]);
  assert.equal(entry.routing.selected_service, "primary");
  assert.equal(entry.routing.selected_key_id, "primary-key");
  assert.equal(entry.upstream.service_id, "primary");
  assert.equal(entry.upstream.key_id, "primary-key");
  assert.equal(entry.upstream.status, 200);
  assert.equal(entry.upstream.attempts.length, 1);
  assert(!captured.lines.some((line) => line.includes("client-key")));
  assert(!captured.lines.some((line) => line.includes("upstream-key")));
  assert(!captured.lines.some((line) => line.includes("upstream-backup-key")));
  assert(!captured.lines.some((line) => line.includes("secret-request-body")));
});

test("gateway logs route application independently from model rewriting", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("ok", { status: 200 });

  const cases = [
    {
      name: "mapped route",
      model: "gpt-5.6-sol",
      configure: () => gatewayConfig(),
      modelRewritten: true,
    },
    {
      name: "self-route with a service constraint",
      model: "review-model",
      configure: () => {
        const config = gatewayConfig();
        config.model_routes["review-model"] = {
          model: "review-model",
          services: ["primary"],
        };
        return config;
      },
      modelRewritten: false,
    },
    {
      name: "unconfigured direct model",
      model: "review-model",
      configure: () => gatewayConfig(),
      modelRewritten: false,
    },
  ];

  try {
    for (const testCase of cases) {
      clearConfigCacheForTests();
      const captured = await captureLogs(() =>
        worker.fetch(
          new Request("https://gateway.example/v1/responses", {
            method: "POST",
            headers: {
              authorization: "Bearer client-key",
              "content-type": "application/json",
            },
            body: JSON.stringify({ model: testCase.model, input: "hello" }),
          }),
          testEnv(testCase.configure()),
          {},
        ),
      );

      assert.equal(captured.value.status, 200, testCase.name);
      assert.equal(captured.entries.length, 1, testCase.name);
      assert.equal(
        captured.entries[0].upstream.model_rewritten,
        testCase.modelRewritten,
        testCase.name,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("gateway applies per-key model routes and keeps other keys on global routes", async () => {
  const originalFetch = globalThis.fetch;
  const upstreamBodies = [];
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    upstreamBodies.push(JSON.parse(await request.text()));
    return new Response("ok", { status: 200 });
  };
  const config = gatewayConfig();
  config.api_keys = [
    {
      id: "gateway-client",
      api_key: "client-key",
      services: ["primary"],
      model_routes: {
        "gpt-5.6-sol": { model: "review-model", services: ["primary"] },
      },
    },
    {
      id: "gateway-client-other",
      api_key: "other-client-key",
      services: ["primary"],
    },
  ];

  try {
    clearConfigCacheForTests();
    const firstResponse = await worker.fetch(
      new Request("https://gateway.example/v1/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer client-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello" }),
      }),
      testEnv(config),
      {},
    );
    assert.equal(firstResponse.status, 200);

    clearConfigCacheForTests();
    const secondResponse = await worker.fetch(
      new Request("https://gateway.example/v1/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer other-client-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello" }),
      }),
      testEnv(config),
      {},
    );
    assert.equal(secondResponse.status, 200);
    assert.deepEqual(
      upstreamBodies.map((body) => body.model),
      ["review-model", "grok-4.5"],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("gateway applies service model routes over per-key and global routes", async () => {
  const originalFetch = globalThis.fetch;
  const upstreamBodies = [];
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    upstreamBodies.push(JSON.parse(await request.text()));
    return new Response("ok", { status: 200 });
  };
  const config = gatewayConfig();
  config.services[0].model_routes = {
    "gpt-5.6-sol": { model: "review-model" },
  };
  config.api_keys[0].model_routes = {
    "gpt-5.6-sol": { model: "grok-4.5" },
  };

  try {
    clearConfigCacheForTests();
    const response = await worker.fetch(
      new Request("https://gateway.example/v1/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer client-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello" }),
      }),
      testEnv(config),
      {},
    );
    assert.equal(response.status, 200);
    assert.deepEqual(
      upstreamBodies.map((body) => body.model),
      ["review-model"],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("gateway rewrites by the selected service route when services differ", async () => {
  const originalFetch = globalThis.fetch;
  const upstreamBodies = [];
  const upstreamUrls = [];
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    upstreamBodies.push(JSON.parse(await request.text()));
    upstreamUrls.push(request.url);
    return new Response("ok", { status: 200 });
  };
  const config = gatewayConfig();
  config.services.push({
    id: "secondary",
    base_url: "https://secondary.example/v1",
    keys: [
      {
        id: "secondary-key",
        api_key: "secondary-secret",
        disabled: false,
        priority: 100,
      },
    ],
    disabled: false,
    priority: 100,
    supports_websocket: true,
    supports_web_search: true,
    models: ["grok-4.5", "review-model"],
  });
  config.api_keys[0].services = ["primary", "secondary"];
  config.api_keys[0].model_routes = {
    "gpt-5.6-sol": { model: "grok-4.5", services: ["secondary"] },
  };
  config.services[0].model_routes = {
    "gpt-5.6-sol": { model: "review-model" },
  };

  try {
    clearConfigCacheForTests();
    const response = await worker.fetch(
      new Request("https://gateway.example/v1/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer client-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello" }),
      }),
      testEnv(config),
      {},
    );
    assert.equal(response.status, 200);
    assert.equal(upstreamUrls[0], "https://primary.example/v1/responses");
    assert.equal(upstreamBodies[0].model, "review-model");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("gateway summarizes configured retries in the single request log", async () => {
  clearConfigCacheForTests();
  const config = gatewayConfig();
  config.services[0].retry = { status_codes: [429], delays_ms: [0, 0] };
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return attempts < 3
      ? Response.json({ error: { code: "rate_limit" } }, { status: 429 })
      : new Response("ok", { status: 200 });
  };

  let captured;
  try {
    captured = await captureLogs(() =>
      worker.fetch(
        new Request("https://gateway.example/v1/responses", {
          method: "POST",
          headers: {
            authorization: "Bearer client-key",
            "content-type": "application/json",
          },
          body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello" }),
        }),
        testEnv(config),
        {},
      ),
    );
    assert.equal(captured.value.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(attempts, 3);
  assert.equal(captured.entries.length, 1);
  assert.deepEqual(
    captured.entries[0].upstream.attempts.map((attempt) => attempt.status),
    [429, 429, 200],
  );
  assert.deepEqual(
    captured.entries[0].upstream.attempts.map(
      (attempt) => attempt.retry_delay_ms ?? null,
    ),
    [0, 0, null],
  );
});

test("model endpoint switches between standard and Codex response formats", async () => {
  clearConfigCacheForTests();
  clearModelsCacheForTests();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      object: "list",
      data: [
        { id: "grok-4.5", object: "model", owned_by: "newapi" },
        { id: "review-model", object: "model", owned_by: "newapi" },
      ],
    });
  const env = testEnv(gatewayConfig());

  try {
    const standard = await worker.fetch(
      new Request("https://gateway.example/v1/models", {
        headers: {
          authorization: "Bearer client-key",
          "user-agent": "OpenAI-SDK",
        },
      }),
      env,
      {},
    );
    const standardBody = await standard.json();
    assert.deepEqual(
      standardBody.data.map((model) => model.id),
      ["grok-4.5", "gpt-5.6-sol", "review-model"],
    );

    const codex = await worker.fetch(
      new Request("https://gateway.example/models", {
        headers: {
          authorization: "Bearer client-key",
          "user-agent": "Codex CLI",
        },
      }),
      env,
      {},
    );
    const codexBody = await codex.json();
    assert.deepEqual(
      codexBody.models.map((model) => model.slug),
      ["gpt-5.6-sol", "codex-auto-review"],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("model endpoint returns complete Anthropic ModelInfo entries to Claude clients", async () => {
  clearConfigCacheForTests();
  clearModelsCacheForTests();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      object: "list",
      data: [
        { id: "grok-4.5", object: "model", owned_by: "newapi" },
        { id: "review-model", object: "model", owned_by: "newapi" },
      ],
    });
  const env = testEnv(gatewayConfig());

  try {
    const response = await worker.fetch(
      new Request("https://gateway.example/v1/models", {
        headers: {
          authorization: "Bearer client-key",
          "user-agent": "claude-cli/1.0.0",
        },
      }),
      env,
      {},
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(
      body.data.map((model) => model.id),
      ["grok-4.5", "gpt-5.6-sol", "review-model"],
    );
    for (const entry of body.data) {
      assert.equal(entry.type, "model");
      assert.equal(typeof entry.display_name, "string");
      assert.equal(typeof entry.created_at, "string");
      assert.equal(typeof entry.max_input_tokens, "number");
      assert.equal(typeof entry.max_tokens, "number");
      assert.equal(typeof entry.capabilities, "object");
    }
    assert.equal(body.data[0].display_name, "grok-4.5");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("model catalog fan-out is summarized in one request log", async () => {
  clearConfigCacheForTests();
  clearModelsCacheForTests();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      data: [
        { id: "grok-4.5", object: "model" },
        { id: "review-model", object: "model" },
      ],
    });

  let captured;
  try {
    captured = await captureLogs(() =>
      worker.fetch(
        new Request("https://gateway.example/v1/models", {
          headers: {
            authorization: "Bearer client-key",
            "user-agent": "OpenAI-SDK",
          },
        }),
        testEnv(gatewayConfig()),
        {},
      ),
    );
    assert.equal(captured.value.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(captured.entries.length, 1);
  const [entry] = captured.entries;
  assert.equal(entry.event, "request.summary");
  assert.equal(entry.client_key_id, "gateway-client");
  assert.deepEqual(entry.routing.candidate_services, ["primary"]);
  assert.deepEqual(entry.routing.selected_keys, [
    { service_id: "primary", key_id: "primary-key" },
  ]);
  assert.deepEqual(entry.routing.checked_available_services, ["primary"]);
  assert.equal(entry.routing.key_checks[0].key_id, "primary-key");
  assert.equal(entry.catalog.cache, "miss");
  assert.equal(Object.hasOwn(entry.catalog, "upstream_errors"), false);
  assert.equal(Object.hasOwn(entry.catalog, "returned_model_count"), false);
});

test("partial model catalog failures remain visible at warn level", async () => {
  clearConfigCacheForTests();
  clearModelsCacheForTests();
  const config = gatewayConfig();
  config.services.push({
    id: "secondary",
    base_url: "https://secondary.example/v1",
    keys: [
      {
        id: "secondary-key",
        api_key: "secondary-key",
        disabled: false,
        priority: 50,
      },
    ],
    disabled: false,
    priority: 50,
    models: ["grok-4.5"],
  });
  config.api_keys[0].services.push("secondary");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.url.startsWith("https://primary.example/")) {
      return Response.json(
        { error: { code: "primary_unavailable" } },
        { status: 500 },
      );
    }
    return Response.json({ data: [{ id: "grok-4.5", object: "model" }] });
  };

  const execution = trackedExecutionContext();
  let captured;
  try {
    captured = await captureLogs(async () => {
      const response = await worker.fetch(
        new Request("https://gateway.example/v1/models", {
          headers: {
            authorization: "Bearer client-key",
            "user-agent": "OpenAI-SDK",
          },
        }),
        {
          ...testEnv(config),
          LOG_LEVEL: "warn",
        },
        execution.context,
      );
      assert.equal(response.status, 200);
      await execution.drain();
      return response;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(captured.entries.length, 1);
  const [entry] = captured.entries;
  assert.equal(entry.event, "request.summary");
  assert.equal(entry.outcome, "partial_success");
  assert.equal(entry.response_status, 200);
  assert.equal(entry.catalog.upstream_errors[0].key_id, "primary-key");
  assert.deepEqual(entry.catalog.upstream_errors[0].error_json, {
    error: { code: "primary_unavailable" },
  });
});

test("model catalog logs JSON upstream errors within one request budget", async () => {
  clearConfigCacheForTests();
  clearModelsCacheForTests();
  const config = gatewayConfig();
  for (let index = 1; index < 3; index += 1) {
    config.services.push({
      id: `service-${index}`,
      base_url: `https://service-${index}.example/v1`,
      keys: [
        {
          id: `service-key-${index}`,
          api_key: `upstream-${index}`,
          disabled: false,
          priority: 100 - index,
        },
      ],
      disabled: false,
      priority: 100 - index,
      models: ["grok-4.5"],
    });
    config.api_keys[0].services.push(`service-${index}`);
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    return Response.json(
      {
        error: {
          service: new URL(request.url).hostname,
          detail: "x".repeat(20 * 1024),
        },
      },
      { status: 500 },
    );
  };

  const execution = trackedExecutionContext();
  let captured;
  try {
    captured = await captureLogs(async () => {
      const response = await worker.fetch(
        new Request("https://gateway.example/v1/models", {
          headers: { authorization: "Bearer client-key" },
        }),
        testEnv(config),
        execution.context,
      );
      assert.equal(response.status, 502);
      await execution.drain();
      return response;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(captured.entries.length, 1);
  const [entry] = captured.entries;
  assert.equal(entry.catalog.upstream_errors.length, 3);
  assert.equal(
    Object.hasOwn(entry.catalog.upstream_errors[0], "error_json"),
    true,
  );
  assert.equal(
    entry.catalog.upstream_errors
      .slice(1)
      .every(
        (upstream) =>
          upstream.error_json_omitted === "request_log_budget_exceeded",
      ),
    true,
  );
  assert.equal(Object.hasOwn(entry.catalog, "returned_model_count"), false);
  assert(JSON.stringify(entry).length < 256 * 1024);
});

test("successful model catalogs are cached for repeated equivalent requests", async () => {
  clearConfigCacheForTests();
  clearModelsCacheForTests();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({
      data: [{ id: "grok-4.5", object: "model" }],
    });
  };

  try {
    const env = {
      ...testEnv(gatewayConfig()),
      MODELS_CACHE_TTL_SECONDS: "30",
    };
    const first = await worker.fetch(
      new Request("https://gateway.example/v1/models", {
        headers: {
          authorization: "Bearer client-key",
          "user-agent": "OpenAI-SDK",
        },
      }),
      env,
      {},
    );
    const second = await worker.fetch(
      new Request("https://gateway.example/v1/models", {
        headers: {
          authorization: "Bearer client-key",
          "user-agent": "OpenAI-SDK",
        },
      }),
      env,
      {},
    );
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(calls, 1);
    assert.deepEqual(await second.json(), await first.clone().json());
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("concurrent model catalog misses do not share request-scoped I/O", async () => {
  clearConfigCacheForTests();
  clearModelsCacheForTests();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let releaseUpstream = () => {};
  const upstreamGate = new Promise((resolve) => {
    releaseUpstream = resolve;
  });
  let markTwoCalls = () => {};
  const twoCalls = new Promise((resolve) => {
    markTwoCalls = resolve;
  });
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 2) {
      markTwoCalls();
    }
    await upstreamGate;
    return Response.json({
      data: [{ id: "grok-4.5", object: "model" }],
    });
  };

  const pending = [];
  let timeout;
  try {
    const env = {
      ...testEnv(gatewayConfig()),
      MODELS_CACHE_TTL_SECONDS: "30",
    };
    for (let index = 0; index < 2; index += 1) {
      pending.push(
        worker.fetch(
          new Request("https://gateway.example/v1/models", {
            headers: {
              authorization: "Bearer client-key",
              "user-agent": "OpenAI-SDK",
            },
          }),
          env,
          {},
        ),
      );
    }

    await Promise.race([
      twoCalls,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                "concurrent model requests shared one upstream operation",
              ),
            ),
          2_000,
        );
      }),
    ]);
    assert.equal(calls, 2);
    releaseUpstream();
    const responses = await Promise.all(pending);
    assert.deepEqual(
      responses.map((response) => response.status),
      [200, 200],
    );
  } finally {
    clearTimeout(timeout);
    releaseUpstream();
    await Promise.allSettled(pending);
    globalThis.fetch = originalFetch;
  }
});

test("disabled services are skipped for inference and model aggregation", async () => {
  clearConfigCacheForTests();
  clearModelsCacheForTests();
  const config = gatewayConfig();
  config.services[0].disabled = true;
  config.services.push({
    id: "secondary",
    base_url: "https://secondary.example/v1",
    keys: [
      {
        id: "secondary-key",
        api_key: "secondary-key",
        disabled: false,
        priority: 50,
      },
    ],
    disabled: false,
    priority: 50,
    models: ["grok-4.5"],
  });
  config.api_keys[0].services.push("secondary");

  const originalFetch = globalThis.fetch;
  const upstreamUrls = [];
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    upstreamUrls.push(request.url);
    if (request.url.endsWith("/models")) {
      return Response.json({
        data: [{ id: "grok-4.5", object: "model", owned_by: "newapi" }],
      });
    }
    return new Response("ok", { status: 200 });
  };

  try {
    const env = testEnv(config);
    const inference = await worker.fetch(
      new Request("https://gateway.example/v1/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer client-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello" }),
      }),
      env,
      {},
    );
    assert.equal(inference.status, 200);

    const models = await worker.fetch(
      new Request("https://gateway.example/v1/models", {
        headers: {
          authorization: "Bearer client-key",
          "user-agent": "OpenAI-SDK",
        },
      }),
      env,
      {},
    );
    assert.equal(models.status, 200);
    assert.deepEqual(
      (await models.json()).data.map((model) => model.id),
      ["grok-4.5", "gpt-5.6-sol"],
    );
    assert.deepEqual(upstreamUrls, [
      "https://secondary.example/v1/responses",
      "https://secondary.example/v1/models",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an upstream error is returned without retrying another service", async () => {
  clearConfigCacheForTests();
  const config = gatewayConfig();
  config.services.push({
    id: "secondary",
    base_url: "https://secondary.example/v1",
    keys: [
      {
        id: "secondary-key",
        api_key: "secondary-key",
        disabled: false,
        priority: 50,
      },
    ],
    disabled: false,
    priority: 50,
    models: ["grok-4.5"],
  });
  config.api_keys[0].services.push("secondary");

  const originalFetch = globalThis.fetch;
  const upstreamUrls = [];
  const upstreamErrorBody = JSON.stringify({
    error: {
      message: "primary failed",
      api_key: "upstream-key",
    },
  });
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    upstreamUrls.push(request.url);
    return new Response(upstreamErrorBody, {
      status: 500,
      headers: {
        "content-type": "application/json",
        "x-request-id": "upstream-request-1",
      },
    });
  };

  let captured;
  const execution = trackedExecutionContext();
  try {
    captured = await captureLogs(async () => {
      const response = await worker.fetch(
        new Request("https://gateway.example/v1/responses", {
          method: "POST",
          headers: {
            authorization: "Bearer client-key",
            "content-type": "application/json",
          },
          body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello" }),
        }),
        testEnv(config),
        execution.context,
      );
      assert.equal(response.status, 500);
      assert.equal(await response.text(), upstreamErrorBody);
      await execution.drain();
      return response;
    });
    assert.deepEqual(upstreamUrls, ["https://primary.example/v1/responses"]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(captured.entries.length, 1);
  const [entry] = captured.entries;
  assert.equal(entry.event, "request.summary");
  assert.equal(entry.outcome, "upstream_error");
  assert.equal(entry.response_status, 500);
  assert.equal(entry.upstream.status, 500);
  assert.equal(entry.upstream.upstream_request_id, "upstream-request-1");
  assert.deepEqual(entry.upstream.error_json, {
    error: {
      message: "primary failed",
      api_key: "[REDACTED]",
    },
  });
  assert(!captured.lines.some((line) => line.includes("upstream-key")));
});

test("JSON upstream error logging does not delay returning the original response", async () => {
  clearConfigCacheForTests();
  const originalFetch = globalThis.fetch;
  let bodyController;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          bodyController = controller;
        },
      }),
      {
        status: 500,
        headers: { "content-type": "application/json" },
      },
    );

  const execution = trackedExecutionContext();
  let captured;
  try {
    captured = await captureLogs(async () => {
      let timer;
      const response = await Promise.race([
        worker.fetch(
          new Request("https://gateway.example/v1/responses", {
            method: "POST",
            headers: {
              authorization: "Bearer client-key",
              "content-type": "application/json",
            },
            body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello" }),
          }),
          testEnv(gatewayConfig()),
          execution.context,
        ),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("response waited for log body")),
            250,
          );
        }),
      ]).finally(() => clearTimeout(timer));
      assert.equal(response.status, 500);
      const upstreamBody = JSON.stringify({ error: { message: "delayed" } });
      bodyController.enqueue(new TextEncoder().encode(upstreamBody));
      bodyController.close();
      await execution.drain();
      assert.equal(await response.text(), upstreamBody);
      return response;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(captured.entries.length, 1);
  assert.deepEqual(captured.entries[0].upstream.error_json, {
    error: { message: "delayed" },
  });
});

test("non-JSON upstream errors log only the status without buffering the body", async () => {
  clearConfigCacheForTests();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("temporary upstream failure", {
      status: 502,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });

  let captured;
  try {
    captured = await captureLogs(() =>
      worker.fetch(
        new Request("https://gateway.example/v1/responses", {
          method: "POST",
          headers: {
            authorization: "Bearer client-key",
            "content-type": "application/json",
          },
          body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello" }),
        }),
        testEnv(gatewayConfig()),
        {},
      ),
    );
    assert.equal(captured.value.status, 502);
    assert.equal(await captured.value.text(), "temporary upstream failure");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(captured.entries.length, 1);
  const [entry] = captured.entries;
  assert.equal(entry.upstream.status, 502);
  assert.equal(Object.hasOwn(entry.upstream, "content_type"), false);
  assert.equal(Object.hasOwn(entry.upstream, "upstream_request_id"), false);
  assert.equal(Object.hasOwn(entry.upstream, "error_json"), false);
  assert.equal(Object.hasOwn(entry.upstream, "error_body_bytes"), false);
});

test("an authenticated client can list and clear health only for allowed services", async () => {
  clearConfigCacheForTests();
  const config = gatewayConfig();
  config.services.push({
    id: "secondary",
    base_url: "https://secondary.example/v1",
    keys: [
      {
        id: "secondary-key",
        api_key: "secondary-key",
        disabled: false,
        priority: 50,
      },
    ],
    disabled: false,
    priority: 50,
    models: ["grok-4.5"],
  });
  const env = testEnv(config);
  for (let index = 0; index < FAILURE_THRESHOLD; index += 1) {
    env.HEALTH.getByName("primary").recordFailure();
    env.HEALTH.getByName("primary:catalog").recordFailure();
    env.HEALTH.getByName("secondary").recordFailure();
  }
  env.HEALTH.getByName("key:primary:primary-key").recordImmediateFailure();
  env.HEALTH.getByName(
    "key:primary:primary-key:catalog",
  ).recordImmediateFailure();
  assert.equal(await serviceIsAvailable(env, "primary"), false);

  const cooling = env.HEALTH.getByName("primary").getStatus();
  const list = await worker.fetch(
    new Request("https://gateway.example/v1/health", {
      headers: { authorization: "Bearer client-key" },
    }),
    env,
    {},
  );
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), {
    object: "list",
    scope: "inference",
    data: [
      { service_id: "primary", ...cooling },
      {
        service_id: "primary",
        key_id: "primary-key",
        ...env.HEALTH.getByName("key:primary:primary-key").getStatus(),
      },
    ],
  });

  const catalogCooling = env.HEALTH.getByName("primary:catalog").getStatus();
  const catalogList = await worker.fetch(
    new Request("https://gateway.example/v1/health?scope=catalog", {
      headers: { authorization: "Bearer client-key" },
    }),
    env,
    {},
  );
  assert.deepEqual(await catalogList.json(), {
    object: "list",
    scope: "catalog",
    data: [
      { service_id: "primary", ...catalogCooling },
      {
        service_id: "primary",
        key_id: "primary-key",
        ...env.HEALTH.getByName("key:primary:primary-key:catalog").getStatus(),
      },
    ],
  });

  const catalogKeyResponse = await worker.fetch(
    new Request(
      "https://gateway.example/health/primary/primary-key?scope=catalog",
      {
        method: "DELETE",
        headers: { authorization: "Bearer client-key" },
      },
    ),
    env,
    {},
  );
  assert.equal(catalogKeyResponse.status, 200);
  assert.equal(
    await keyIsAvailable(env, "primary", "primary-key", "catalog"),
    true,
  );
  assert.equal(await serviceIsAvailable(env, "primary", "catalog"), false);

  const keyResponse = await worker.fetch(
    new Request("https://gateway.example/v1/health/primary/primary-key", {
      method: "DELETE",
      headers: { authorization: "Bearer client-key" },
    }),
    env,
    {},
  );
  assert.equal(keyResponse.status, 200);
  assert.deepEqual(await keyResponse.json(), {
    service_id: "primary",
    key_id: "primary-key",
    scope: "inference",
    failures: 0,
    cooling_until: null,
  });
  assert.equal(await keyIsAvailable(env, "primary", "primary-key"), true);
  assert.equal(await serviceIsAvailable(env, "primary"), false);

  const response = await worker.fetch(
    new Request("https://gateway.example/v1/health/primary", {
      method: "DELETE",
      headers: { authorization: "Bearer client-key" },
    }),
    env,
    {},
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    service_id: "primary",
    scope: "inference",
    failures: 0,
    cooling_until: null,
  });
  assert.equal(await serviceIsAvailable(env, "primary"), true);

  const empty = await worker.fetch(
    new Request("https://gateway.example/health", {
      headers: { authorization: "Bearer client-key" },
    }),
    env,
    {},
  );
  assert.deepEqual((await empty.json()).data, []);

  const forbidden = await worker.fetch(
    new Request("https://gateway.example/v1/health/secondary", {
      method: "DELETE",
      headers: { authorization: "Bearer client-key" },
    }),
    env,
    {},
  );
  assert.equal(forbidden.status, 404);

  const missingKey = await worker.fetch(
    new Request("https://gateway.example/v1/health/primary/missing-key", {
      method: "DELETE",
      headers: { authorization: "Bearer client-key" },
    }),
    env,
    {},
  );
  assert.equal(missingKey.status, 404);
});

test("health endpoints reject an invalid scope", async () => {
  clearConfigCacheForTests();
  const response = await worker.fetch(
    new Request("https://gateway.example/health/primary?scope=all", {
      method: "DELETE",
      headers: { authorization: "Bearer client-key" },
    }),
    testEnv(gatewayConfig()),
    {},
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "invalid_health_scope");

  const list = await worker.fetch(
    new Request("https://gateway.example/v1/health?scope=all", {
      headers: { authorization: "Bearer client-key" },
    }),
    testEnv(gatewayConfig()),
    {},
  );
  assert.equal(list.status, 400);
  assert.equal((await list.json()).error.code, "invalid_health_scope");
});

test("authenticated clients can page, inspect, and delete only their session bindings", async () => {
  clearConfigCacheForTests();
  const config = gatewayConfig();
  config.api_keys.push({
    id: "other-client",
    api_key: "other-client-key",
    services: ["primary"],
  });
  const env = testEnv(config);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 200 });
  const createSession = async (apiKey, sessionId) => {
    const response = await worker.fetch(
      new Request("https://gateway.example/v1/responses", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "session-id": sessionId,
        },
        body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello" }),
      }),
      env,
      {},
    );
    assert.equal(response.status, 200);
  };

  try {
    for (const sessionId of ["first", "second", "path/value", "unindexed"]) {
      await createSession("client-key", sessionId);
    }
    await createSession("other-client-key", "other");
  } finally {
    globalThis.fetch = originalFetch;
  }

  const firstPage = await worker.fetch(
    new Request("https://gateway.example/sessions?limit=2", {
      headers: { authorization: "Bearer client-key" },
    }),
    env,
    {},
  );
  assert.equal(firstPage.status, 200);
  assert.equal(firstPage.headers.get("cache-control"), "no-store");
  const firstPayload = await firstPage.json();
  assert.equal(firstPayload.object, "list");
  assert.equal(firstPayload.data.length, 2);
  assert.equal(typeof firstPayload.next_cursor, "string");
  for (const binding of firstPayload.data) {
    assert.equal(binding.service_id, "primary");
    assert.equal(binding.key_id, "primary-key");
    assert.equal(typeof binding.created_at, "number");
    assert.equal(typeof binding.updated_at, "number");
    assert.equal(
      binding.expires_at,
      binding.updated_at + SESSION_AFFINITY_TTL_MS,
    );
  }

  const secondPage = await worker.fetch(
    new Request(
      `https://gateway.example/v1/sessions?limit=2&cursor=${encodeURIComponent(firstPayload.next_cursor)}`,
      { headers: { authorization: "Bearer client-key" } },
    ),
    env,
    {},
  );
  const secondPayload = await secondPage.json();
  assert.equal(secondPayload.next_cursor, null);
  assert.deepEqual(
    new Set(
      [...firstPayload.data, ...secondPayload.data].map(
        (entry) => entry.session_id,
      ),
    ),
    new Set(["first", "second", "path/value", "unindexed"]),
  );

  const isolated = await worker.fetch(
    new Request("https://gateway.example/v1/sessions", {
      headers: { authorization: "Bearer other-client-key" },
    }),
    env,
    {},
  );
  assert.deepEqual(
    (await isolated.json()).data.map((entry) => entry.session_id),
    ["other"],
  );

  const unindexedIdentity = await sessionAffinityIdentity(
    "client-key",
    "unindexed",
  );
  const unindexedRegistry = env.SESSION_AFFINITY_INDEX.getByName(
    unindexedIdentity.registry_name,
  );
  const unindexedEntry = await unindexedRegistry.get(
    unindexedIdentity.session_digest,
  );
  assert.ok(unindexedEntry);
  assert.equal(
    await unindexedRegistry.remove(
      unindexedIdentity.session_digest,
      unindexedEntry.binding_id,
      unindexedEntry.generation,
    ),
    true,
  );
  const removedUnindexed = await worker.fetch(
    new Request("https://gateway.example/sessions/unindexed", {
      method: "DELETE",
      headers: { authorization: "Bearer client-key" },
    }),
    env,
    {},
  );
  assert.deepEqual(await removedUnindexed.json(), {
    session_id: "unindexed",
    deleted: 1,
  });

  const encodedSessionId = encodeURIComponent("path/value");
  const removed = await worker.fetch(
    new Request(`https://gateway.example/v1/sessions/${encodedSessionId}`, {
      method: "DELETE",
      headers: { authorization: "Bearer client-key" },
    }),
    env,
    {},
  );
  assert.deepEqual(await removed.json(), {
    session_id: "path/value",
    deleted: 1,
  });
  const repeated = await worker.fetch(
    new Request(`https://gateway.example/sessions/${encodedSessionId}`, {
      method: "DELETE",
      headers: { authorization: "Bearer client-key" },
    }),
    env,
    {},
  );
  assert.deepEqual(await repeated.json(), {
    session_id: "path/value",
    deleted: 0,
  });

  const cleared = await worker.fetch(
    new Request("https://gateway.example/sessions", {
      method: "DELETE",
      headers: { authorization: "Bearer client-key" },
    }),
    env,
    {},
  );
  assert.equal(cleared.headers.get("cache-control"), "no-store");
  assert.deepEqual(await cleared.json(), { deleted: 2 });
  const empty = await worker.fetch(
    new Request("https://gateway.example/v1/sessions", {
      headers: { authorization: "Bearer client-key" },
    }),
    env,
    {},
  );
  assert.deepEqual((await empty.json()).data, []);
});

test("a stale indexed delete protects the replacement and remains retryable", async () => {
  clearConfigCacheForTests();
  const config = gatewayConfig();
  const env = testEnv(config);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 200 });
  try {
    const create = await worker.fetch(
      new Request("https://gateway.example/v1/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer client-key",
          "content-type": "application/json",
          "session-id": "stale-index-session",
        },
        body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello" }),
      }),
      env,
      {},
    );
    assert.equal(create.status, 200);

    const identity = await sessionAffinityIdentity(
      "client-key",
      "stale-index-session",
    );
    const affinity = env.SESSION_AFFINITY.getByName(identity.object_name);
    const current = await affinity.getStatus();
    assert.ok(current?.binding_id);
    const index = env.SESSION_AFFINITY_INDEX.getByName(identity.registry_name);
    assert.equal(
      await index.remove(
        identity.session_digest,
        current.binding_id,
        current.generation,
      ),
      true,
    );
    await index.register({
      session_digest: identity.session_digest,
      session_id: identity.session_id,
      binding_id: "stale-binding",
      created_at: current.created_at,
      generation: Math.max(1, current.generation - 1),
    });

    const deleted = await worker.fetch(
      new Request("https://gateway.example/sessions/stale-index-session", {
        method: "DELETE",
        headers: { authorization: "Bearer client-key" },
      }),
      env,
      {},
    );
    assert.deepEqual(await deleted.json(), {
      session_id: "stale-index-session",
      deleted: 0,
    });
    assert.notEqual(await affinity.getStatus(), null);
    assert.equal(await index.get(identity.session_digest), null);

    // The failed conditional delete is safe to retry after the stale index
    // row has been removed; the missing-index path can then clear the current
    // managed record by its registration metadata.
    const retried = await worker.fetch(
      new Request("https://gateway.example/sessions/stale-index-session", {
        method: "DELETE",
        headers: { authorization: "Bearer client-key" },
      }),
      env,
      {},
    );
    assert.deepEqual(await retried.json(), {
      session_id: "stale-index-session",
      deleted: 1,
    });
    assert.equal(await affinity.getStatus(), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("session endpoints validate methods, pagination, authentication, and session ids", async () => {
  clearConfigCacheForTests();
  const env = testEnv(gatewayConfig());
  const wrongMethod = await worker.fetch(
    new Request("https://gateway.example/sessions", { method: "POST" }),
    env,
    {},
  );
  assert.equal(wrongMethod.status, 405);

  const unauthorized = await worker.fetch(
    new Request("https://gateway.example/v1/sessions"),
    env,
    {},
  );
  assert.equal(unauthorized.status, 401);

  for (const search of [
    "?limit=",
    "?limit=0",
    "?limit=1001",
    "?cursor=invalid",
  ]) {
    const response = await worker.fetch(
      new Request(`https://gateway.example/sessions${search}`, {
        headers: { authorization: "Bearer client-key" },
      }),
      env,
      {},
    );
    assert.equal(response.status, 400);
    assert.equal(
      (await response.json()).error.code,
      "invalid_session_list_query",
    );
  }

  const invalidSession = await worker.fetch(
    new Request("https://gateway.example/v1/sessions/", {
      method: "DELETE",
      headers: { authorization: "Bearer client-key" },
    }),
    env,
    {},
  );
  assert.equal(invalidSession.status, 400);
  assert.equal((await invalidSession.json()).error.code, "invalid_session_id");

  const paddedSessionId = await worker.fetch(
    new Request("https://gateway.example/sessions/%20padded%20", {
      method: "DELETE",
      headers: { authorization: "Bearer client-key" },
    }),
    env,
    {},
  );
  assert.deepEqual(await paddedSessionId.json(), {
    session_id: " padded ",
    deleted: 0,
  });
});
