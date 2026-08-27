import assert from "node:assert/strict";
import test from "node:test";

import { keyIsAvailable, ServiceHealthState } from "../src/health.ts";
import {
  aggregateCodexModels,
  aggregateStandardModels,
  clearModelsCacheForTests,
  handleModels,
  MAX_MODEL_CATALOG_BODY_BYTES,
  MODEL_CATALOG_CONCURRENCY,
  modelsFormatFor,
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
  assert.deepEqual(
    models.map((model) => model.id),
    ["grok-4.5", "gpt-5.6-sol"],
  );
});

test("standard aggregation honors route service constraints", () => {
  const models = aggregateStandardModels(results, {
    "gpt-5.6-sol": { model: "grok-4.5", services: ["secondary"] },
  });
  assert.deepEqual(
    models.map((model) => model.id),
    ["grok-4.5"],
  );
});

test("a self-route hides a model supplied only by disallowed services", () => {
  const routes = {
    "grok-4.5": { model: "grok-4.5", services: ["secondary"] },
  };
  assert.deepEqual(aggregateStandardModels(results, routes), []);

  const secondaryResults = [
    {
      ...results[0],
      service: { id: "secondary", models: ["grok-4.5"] },
    },
  ];
  assert.deepEqual(
    aggregateStandardModels(secondaryResults, routes).map((model) => model.id),
    ["grok-4.5"],
  );
});

test("Codex aggregation only returns exact catalog matches", () => {
  const models = aggregateCodexModels(
    new Set(["grok-4.5", "gpt-5.6-sol", "codex-auto-review"]),
  );
  assert.deepEqual(
    models.map((model) => model.slug),
    ["gpt-5.6-sol", "codex-auto-review"],
  );
});

test("Anthropic clients receive the Anthropic model-list shape", async () => {
  clearModelsCacheForTests();
  const config = modelConfig();
  const client = config.api_keys[0];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ data: [{ id: "model", object: "model" }] });
  const { env } = healthEnvironment();

  try {
    const response = await handleModels(
      new Request("https://gateway.example/v1/models", {
        headers: {
          "x-api-key": "client",
          "anthropic-version": "2023-06-01",
          "user-agent": "claude-cli/1.0.0",
        },
      }),
      env,
      config,
      client,
      "test",
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.has_more, false);
    assert.equal(body.first_id, "model");
    assert.equal(body.last_id, "model");
    assert.deepEqual(
      body.data.map((entry) => entry.id),
      ["model"],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Anthropic model entries carry the ModelInfo fields Claude requires", async () => {
  clearModelsCacheForTests();
  const config = modelConfig();
  config.services[0].models = ["grok-4.6", "gpt-5.6-sol"];
  const client = config.api_keys[0];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      data: [
        { id: "grok-4.6", object: "model" },
        { id: "gpt-5.6-sol", object: "model" },
      ],
    });
  const { env } = healthEnvironment();

  try {
    const response = await handleModels(
      new Request("https://gateway.example/v1/models", {
        headers: {
          "x-api-key": "client",
          "anthropic-version": "2023-06-01",
          "user-agent": "claude-cli/1.0.0",
        },
      }),
      env,
      config,
      client,
      "test",
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(
      body.data.map((entry) => entry.id),
      ["grok-4.6", "gpt-5.6-sol"],
    );
    const grok = body.data.find((entry) => entry.id === "grok-4.6");
    assert.equal(grok.type, "model");
    assert.equal(grok.display_name, "Grok 4.6");
    assert.equal(typeof grok.created_at, "string");
    assert.equal(grok.max_input_tokens, 1048576);
    assert.equal(typeof grok.max_tokens, "number");
    assert.equal(grok.capabilities.image_input.supported, true);
    assert.equal(grok.capabilities.pdf_input.supported, false);
    assert.equal(grok.capabilities.code_execution.supported, false);
    assert.equal(grok.capabilities.effort.supported, true);
    assert.deepEqual(grok.capabilities.effort, {
      supported: true,
      low: { supported: true },
      medium: { supported: true },
      high: { supported: true },
      max: { supported: false },
      xhigh: { supported: true },
    });
    assert.equal(grok.capabilities.thinking.supported, true);
    assert.deepEqual(grok.capabilities.thinking.types, {
      adaptive: { supported: true },
      enabled: { supported: true },
    });

    const gpt = body.data.find((entry) => entry.id === "gpt-5.6-sol");
    assert.equal(gpt.display_name, "GPT-5.6-Sol");
    assert.equal(gpt.max_input_tokens, 872000);
    assert.equal(gpt.capabilities.image_input.supported, true);
    assert.equal(gpt.capabilities.code_execution.supported, true);
    assert.equal(gpt.capabilities.effort.max.supported, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Anthropic model entries fall back conservatively outside the catalog", async () => {
  clearModelsCacheForTests();
  const config = modelConfig();
  const client = config.api_keys[0];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ data: [{ id: "model", object: "model" }] });
  const { env } = healthEnvironment();

  try {
    const response = await handleModels(
      new Request("https://gateway.example/v1/models", {
        headers: {
          "x-api-key": "client",
          "anthropic-version": "2023-06-01",
          "user-agent": "claude-cli/1.0.0",
        },
      }),
      env,
      config,
      client,
      "test",
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    const entry = body.data[0];
    assert.equal(entry.display_name, "model");
    assert.equal(entry.max_input_tokens, 200000);
    assert.equal(entry.max_tokens, 32000);
    assert.equal(entry.capabilities.image_input.supported, false);
    assert.equal(entry.capabilities.pdf_input.supported, false);
    assert.equal(entry.capabilities.code_execution.supported, false);
    assert.equal(entry.capabilities.effort.supported, false);
    assert.equal(entry.capabilities.thinking.supported, false);
    assert.equal(entry.capabilities.context_management.supported, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("model format selection prefers the Anthropic protocol over user agents", () => {
  const anthropic = new Request("https://gateway.example/v1/models", {
    headers: { "anthropic-version": "2023-06-01", "user-agent": "codex/1.0" },
  });
  assert.equal(modelsFormatFor(anthropic), "anthropic");
  const codex = new Request("https://gateway.example/v1/models", {
    headers: { "user-agent": "codex/1.0" },
  });
  assert.equal(modelsFormatFor(codex), "codex");
  const openai = new Request("https://gateway.example/v1/models", {
    headers: { "user-agent": "OpenAI-SDK" },
  });
  assert.equal(modelsFormatFor(openai), "openai");
});

test("model format selection detects Claude user agents without protocol headers", () => {
  const claudeCli = new Request("https://gateway.example/v1/models", {
    headers: { "user-agent": "claude-cli/1.0.0" },
  });
  assert.equal(modelsFormatFor(claudeCli), "anthropic");
  const claudeDesktop = new Request("https://gateway.example/v1/models", {
    headers: { "user-agent": "claude-desktop" },
  });
  assert.equal(modelsFormatFor(claudeDesktop), "anthropic");
  const claudeCode = new Request("https://gateway.example/v1/models", {
    headers: { "user-agent": "claude-code/2.0" },
  });
  assert.equal(modelsFormatFor(claudeCode), "anthropic");
});

test("model cache key hashing failures propagate", async (t) => {
  clearModelsCacheForTests();
  t.mock.method(crypto.subtle, "digest", async () => {
    throw new Error("SHA-256 unavailable");
  });
  const config = modelConfig();
  const { env } = healthEnvironment();

  await assert.rejects(
    handleModels(modelRequest(), env, config, config.api_keys[0]),
    /SHA-256 unavailable/,
  );
});

test("model catalogs reflect each client's per-key model routes", async () => {
  clearModelsCacheForTests();
  const config = modelConfig();
  config.api_keys = [
    {
      id: "client-a",
      api_key: "client-a",
      services: ["service-0"],
      model_routes: {
        "per-key-alias": { model: "model" },
        "global-alias": { model: "model", services: ["service-0"] },
      },
    },
    {
      id: "client-b",
      api_key: "client-b",
      services: ["service-0"],
    },
  ];
  config.model_routes = {
    "global-alias": { model: "model" },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ data: [{ id: "model", object: "model" }] });
  const { env } = healthEnvironment();

  try {
    const first = await handleModels(
      new Request("https://gateway.example/v1/models", {
        headers: {
          authorization: "Bearer client-a",
          "user-agent": "OpenAI-SDK",
        },
      }),
      env,
      config,
      config.api_keys[0],
      "first",
    );
    const second = await handleModels(
      new Request("https://gateway.example/v1/models", {
        headers: {
          authorization: "Bearer client-b",
          "user-agent": "OpenAI-SDK",
        },
      }),
      env,
      config,
      config.api_keys[1],
      "second",
    );
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual(
      (await first.json()).data.map((model) => model.id),
      ["model", "global-alias", "per-key-alias"],
    );
    assert.deepEqual(
      (await second.json()).data.map((model) => model.id),
      ["model", "global-alias"],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
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
    api_keys: [
      {
        id: "client",
        api_key: "client",
        services: services.map((service) => service.id),
      },
    ],
    model_routes: {
      "codex-auto-review": { model: "model", services: [services[0].id] },
    },
  };
}

function healthEnvironment() {
  const calls = { failure: 0, keyFailure: 0, success: 0 };
  const objects = new Map();
  const getByName = (name) => {
    if (!objects.has(name)) {
      const state = new ServiceHealthState();
      objects.set(name, {
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
    return objects.get(name);
  };
  return {
    calls,
    env: {
      HEALTH: { getByName },
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
    const response = await handleModels(
      modelRequest(),
      env,
      config,
      client,
      "test",
    );
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
    const response = await handleModels(
      modelRequest(),
      env,
      config,
      client,
      "test",
    );
    assert.equal(response.status, 502);
    assert.equal(calls.failure, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HTTP 403 model catalog responses cool only the selected catalog key", async () => {
  clearModelsCacheForTests();
  const config = modelConfig();
  const client = config.api_keys[0];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 403 });
  const { calls, env } = healthEnvironment();

  try {
    const response = await handleModels(
      modelRequest(),
      env,
      config,
      client,
      "test",
    );
    assert.equal(response.status, 502);
    assert.equal(calls.keyFailure, 1);
    assert.equal(calls.failure, 0);
    assert.equal(
      await keyIsAvailable(env, "service-0", "primary-key-0", "catalog"),
      false,
    );
    assert.equal(
      await keyIsAvailable(env, "service-0", "primary-key-0", "inference"),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a catalog-cooled key is replaced only on the next catalog request", async () => {
  clearModelsCacheForTests();
  const config = modelConfig();
  const client = config.api_keys[0];
  const originalFetch = globalThis.fetch;
  const authorizations = [];
  let attempts = 0;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    authorizations.push(request.headers.get("authorization"));
    attempts += 1;
    return attempts === 1
      ? new Response(null, { status: 403 })
      : Response.json({ data: [{ id: "model", object: "model" }] });
  };
  const { env } = healthEnvironment();

  try {
    const first = await handleModels(
      modelRequest(),
      env,
      config,
      client,
      "first",
    );
    clearModelsCacheForTests();
    const second = await handleModels(
      modelRequest(),
      env,
      config,
      client,
      "second",
    );
    assert.equal(first.status, 502);
    assert.equal(second.status, 200);
    assert.deepEqual(authorizations, [
      "Bearer upstream-0",
      "Bearer upstream-backup-0",
    ]);
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
    const response = await handleModels(
      modelRequest(),
      env,
      config,
      client,
      "test",
    );
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
    const response = await handleModels(
      modelRequest(),
      env,
      config,
      client,
      "test",
    );
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
    const response = await handleModels(
      modelRequest(),
      env,
      config,
      client,
      "test",
    );
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
    const response = await handleModels(
      modelRequest(),
      env,
      config,
      client,
      "test",
    );
    assert.equal(response.status, 200);
    assert.deepEqual(urls, ["https://service-1.example/v1/models"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
