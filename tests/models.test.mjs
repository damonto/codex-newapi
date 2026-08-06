import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateCodexModels,
  aggregateStandardModels,
  clearModelsCacheForTests,
  handleModels,
  MAX_MODEL_CATALOG_BODY_BYTES,
  MODEL_CATALOG_CONCURRENCY,
} from "../src/models.ts";

const results = [
  {
    service: { id: "primary", models: ["grok-4.5"] },
    success: true,
    models: [
      {
        id: "grok-4.5",
        raw: { id: "grok-4.5", object: "model", owned_by: "newapi" },
      },
    ],
  },
];

test("standard aggregation adds a route without hiding the upstream model", () => {
  const models = aggregateStandardModels(results, {
    "gpt-5.6-sol": { model: "grok-4.5" },
  });
  assert.deepEqual(models.map((model) => model.id), ["grok-4.5", "gpt-5.6-sol"]);
});

test("standard aggregation honors route service constraints", () => {
  const models = aggregateStandardModels(results, {
    "gpt-5.6-sol": { model: "grok-4.5", services: ["secondary"] },
  });
  assert.deepEqual(models.map((model) => model.id), ["grok-4.5"]);
});

test("a self-route hides a model supplied only by disallowed services", () => {
  const routes = {
    "grok-4.5": { model: "grok-4.5", services: ["secondary"] },
  };
  assert.deepEqual(aggregateStandardModels(results, routes), []);

  const secondaryResults = [{
    ...results[0],
    service: { id: "secondary", models: ["grok-4.5"] },
  }];
  assert.deepEqual(
    aggregateStandardModels(secondaryResults, routes).map((model) => model.id),
    ["grok-4.5"],
  );
});

test("Codex aggregation only returns exact catalog matches", () => {
  const models = aggregateCodexModels(new Set(["grok-4.5", "gpt-5.6-sol", "codex-auto-review"]));
  assert.deepEqual(
    models.map((model) => model.slug),
    ["gpt-5.6-sol", "codex-auto-review"],
  );
});

function modelConfig(serviceCount = 1) {
  const services = Array.from({ length: serviceCount }, (_, index) => ({
    id: `service-${index}`,
    base_url: `https://service-${index}.example/v1`,
    keys: [
      {
        id: `primary-key-${index}`,
        api_key: `upstream-${index}`,
        disabled: false,
        priority: 100,
      },
      {
        id: `backup-key-${index}`,
        api_key: `upstream-backup-${index}`,
        disabled: false,
        priority: 50,
      },
    ],
    disabled: false,
    priority: serviceCount - index,
    models: ["model"],
  }));
  return {
    services,
    api_keys: [{ api_key: "client", services: services.map((service) => service.id) }],
    model_routes: {
      "codex-auto-review": { model: "model", services: [services[0].id] },
    },
  };
}

function healthEnvironment() {
  const calls = { failure: 0, success: 0 };
  const snapshot = { failures: 0, cooling_until: null };
  const stub = {
    getStatus: async () => snapshot,
    recordFailure: async () => {
      calls.failure += 1;
      return snapshot;
    },
    recordSuccess: async () => {
      calls.success += 1;
      return snapshot;
    },
  };
  return {
    calls,
    env: {
      HEALTH: { getByName: () => stub },
      MODELS_CACHE_TTL_SECONDS: "0",
    },
  };
}

function modelRequest() {
  return new Request("https://gateway.example/v1/models", {
    headers: { authorization: "Bearer client", "user-agent": "OpenAI-SDK" },
  });
}

test("model catalogs cancel unused error bodies and only 400/503 affect HTTP health", async () => {
  clearModelsCacheForTests();
  const config = modelConfig();
  const client = config.api_keys[0];
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { status: 500 },
    );
  const { calls, env } = healthEnvironment();

  try {
    const response = await handleModels(modelRequest(), env, config, client, "test");
    assert.equal(response.status, 502);
    assert.equal(cancelled, true);
    assert.equal(calls.failure, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HTTP 503 model catalog responses increment catalog health", async () => {
  clearModelsCacheForTests();
  const config = modelConfig();
  const client = config.api_keys[0];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 503 });
  const { calls, env } = healthEnvironment();

  try {
    const response = await handleModels(modelRequest(), env, config, client, "test");
    assert.equal(response.status, 502);
    assert.equal(calls.failure, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("oversized model catalogs are cancelled before buffering", async () => {
  clearModelsCacheForTests();
  const config = modelConfig();
  const client = config.api_keys[0];
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      {
        status: 200,
        headers: { "content-length": String(MAX_MODEL_CATALOG_BODY_BYTES + 1) },
      },
    );
  const { calls, env } = healthEnvironment();

  try {
    const response = await handleModels(modelRequest(), env, config, client, "test");
    assert.equal(response.status, 502);
    assert.equal(cancelled, true);
    assert.equal(calls.failure, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("model catalog fan-out is bounded", async () => {
  clearModelsCacheForTests();
  const config = modelConfig(MODEL_CATALOG_CONCURRENCY * 2);
  const client = config.api_keys[0];
  const originalFetch = globalThis.fetch;
  let active = 0;
  let maximumActive = 0;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    return Response.json({ data: [{ id: "model", object: "model" }] });
  };
  const { env } = healthEnvironment();

  try {
    const response = await handleModels(modelRequest(), env, config, client, "test");
    assert.equal(response.status, 200);
    assert.equal(calls, MODEL_CATALOG_CONCURRENCY * 2);
    assert.equal(maximumActive, MODEL_CATALOG_CONCURRENCY);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("model catalogs use one selected key per service", async () => {
  clearModelsCacheForTests();
  const config = modelConfig();
  config.services[0].keys[0].disabled = true;
  const client = config.api_keys[0];
  const originalFetch = globalThis.fetch;
  const authorizations = [];
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    authorizations.push(request.headers.get("authorization"));
    return Response.json({ data: [{ id: "model", object: "model" }] });
  };
  const { env } = healthEnvironment();

  try {
    const response = await handleModels(modelRequest(), env, config, client, "test");
    assert.equal(response.status, 200);
    assert.deepEqual(authorizations, ["Bearer upstream-backup-0"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("model catalogs skip services without an enabled key", async () => {
  clearModelsCacheForTests();
  const config = modelConfig(2);
  config.services[0].keys = config.services[0].keys.map((key) => ({
    ...key,
    disabled: true,
  }));
  const client = config.api_keys[0];
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    urls.push(request.url);
    return Response.json({ data: [{ id: "model", object: "model" }] });
  };
  const { env } = healthEnvironment();

  try {
    const response = await handleModels(modelRequest(), env, config, client, "test");
    assert.equal(response.status, 200);
    assert.deepEqual(urls, ["https://service-1.example/v1/models"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
