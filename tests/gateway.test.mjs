import assert from "node:assert/strict";
import test from "node:test";

import { clearConfigCacheForTests } from "../src/config.ts";
import { FAILURE_THRESHOLD, serviceIsAvailable, ServiceHealthState } from "../src/health.ts";
import worker from "../src/index.ts";
import { clearModelsCacheForTests } from "../src/models.ts";

function gatewayConfig() {
  return {
    services: [
      {
        id: "primary",
        base_url: "https://primary.example/v1",
        api_key: "upstream-key",
        disabled: false,
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
      getByName: (name) => {
        if (!healthObjects.has(name)) {
          healthObjects.set(name, new ServiceHealthState());
        }
        return healthObjects.get(name);
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

test("disabled services are skipped for inference and model aggregation", async () => {
  clearConfigCacheForTests();
  clearModelsCacheForTests();
  const config = gatewayConfig();
  config.services[0].disabled = true;
  config.services.push({
    id: "secondary",
    base_url: "https://secondary.example/v1",
    api_key: "secondary-key",
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
        headers: { authorization: "Bearer client-key", "user-agent": "OpenAI-SDK" },
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
    api_key: "secondary-key",
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

test("an authenticated client can list and clear health only for allowed services", async () => {
  clearConfigCacheForTests();
  const config = gatewayConfig();
  config.services.push({
    id: "secondary",
    base_url: "https://secondary.example/v1",
    api_key: "secondary-key",
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
    data: [{ service_id: "primary", ...cooling }],
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
    data: [{ service_id: "primary", ...catalogCooling }],
  });

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
