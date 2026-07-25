import assert from "node:assert/strict";
import test from "node:test";

import { clearConfigCacheForTests } from "../src/config.ts";
import { ServiceHealth } from "../src/health.ts";
import worker from "../src/index.ts";
import { clearModelsCacheForTests } from "../src/models.ts";

function gatewayConfig() {
  return {
    services: [
      {
        id: "primary",
        base_url: "https://primary.example/v1",
        api_key: "upstream-key",
        priority: 100,
        models: ["grok-4.5", "review-model"],
      },
    ],
    api_keys: [{ api_key: "client-key", services: ["primary"] }],
    model_aliases: { "gpt-5.6-sol": "grok-4.5" },
    codex_auto_review: { service: "primary", model: "review-model" },
  };
}

function testEnv(config) {
  const healthObjects = new Map();
  return {
    CODEX_NEWAPI_CONFIG_KV: {
      get: async () => JSON.stringify(config),
    },
    HEALTH: {
      idFromName: (name) => name,
      get: (id) => {
        if (!healthObjects.has(id)) {
          healthObjects.set(id, new ServiceHealth({}, {}));
        }
        return {
          fetch: (input, init) => {
            const request = input instanceof Request ? input : new Request(input, init);
            return healthObjects.get(id).fetch(request);
          },
        };
      },
    },
    CONFIG_KEY: "gateway-config",
    CONFIG_CACHE_TTL_SECONDS: "0",
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
        body: JSON.stringify({ model: "gpt-5.6-sol", stream: true, input: "hello" }),
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

test("gateway logs correlate a request without logging credentials or body content", async () => {
  clearConfigCacheForTests();
  const originalFetch = globalThis.fetch;
  const originalConsole = {
    error: console.error,
    log: console.log,
    warn: console.warn,
  };
  const lines = [];
  for (const level of ["error", "log", "warn"]) {
    console[level] = (...args) => lines.push(args.map(String).join(" "));
  }
  globalThis.fetch = async () => new Response("ok", { status: 200 });

  try {
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
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsole.error;
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
  }

  const entries = lines.map((line) => JSON.parse(line));
  const requestIds = new Set(
    entries
      .map((entry) => entry.request_id)
      .filter((requestId) => typeof requestId === "string"),
  );
  assert.equal(requestIds.size, 1);
  assert(entries.some((entry) => entry.event === "request.started"));
  assert(entries.some((entry) => entry.event === "inference.route.resolved"));
  assert(entries.some((entry) => entry.event === "request.completed"));
  assert(!lines.some((line) => line.includes("client-key")));
  assert(!lines.some((line) => line.includes("secret-request-body")));
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
        headers: { authorization: "Bearer client-key", "user-agent": "OpenAI-SDK" },
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
        headers: { authorization: "Bearer client-key", "user-agent": "Codex CLI" },
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
        headers: { authorization: "Bearer client-key", "user-agent": "OpenAI-SDK" },
      }),
      env,
      {},
    );
    const second = await worker.fetch(
      new Request("https://gateway.example/v1/models", {
        headers: { authorization: "Bearer client-key", "user-agent": "OpenAI-SDK" },
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

test("an upstream error is returned without retrying another service", async () => {
  clearConfigCacheForTests();
  const config = gatewayConfig();
  config.services.push({
    id: "secondary",
    base_url: "https://secondary.example/v1",
    api_key: "secondary-key",
    priority: 50,
    models: ["grok-4.5"],
  });
  config.api_keys[0].services.push("secondary");

  const originalFetch = globalThis.fetch;
  const upstreamUrls = [];
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    upstreamUrls.push(request.url);
    return new Response('{"error":"primary failed"}', {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  };

  try {
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
    assert.equal(response.status, 500);
    assert.equal(await response.text(), '{"error":"primary failed"}');
    assert.deepEqual(upstreamUrls, ["https://primary.example/v1/responses"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
