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
        models: ["grok-4.5", "review-model"],
      },
    ],
    api_keys: [{ api_key: "client-key", services: ["primary"] }],
    model_routes: {
      "gpt-5.6-sol": { model: "grok-4.5" },
      "codex-auto-review": { model: "review-model", services: ["primary"] },
    },
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
      const entry = args.length === 1 && typeof args[0] === "object" && args[0] !== null
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
      new Request("https://gateway.example/v1/images/generations?trace=generation", {
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
      }),
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
      routeApplied: true,
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
      routeApplied: true,
      modelRewritten: false,
    },
    {
      name: "unconfigured direct model",
      model: "review-model",
      configure: () => gatewayConfig(),
      routeApplied: false,
      modelRewritten: false,
    },
  ];

  try {
    for (const testCase of cases) {
      clearConfigCacheForTests();
      const captured = await captureLogs(() => worker.fetch(
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
      ));

      assert.equal(captured.value.status, 200, testCase.name);
      assert.equal(captured.entries.length, 1, testCase.name);
      assert.equal(
        captured.entries[0].model.route_applied,
        testCase.routeApplied,
        testCase.name,
      );
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
    captured = await captureLogs(() => worker.fetch(
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
    ));
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
    captured.entries[0].upstream.attempts.map((attempt) => attempt.retry_delay_ms ?? null),
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

test("model catalog fan-out is summarized in one request log", async () => {
  clearConfigCacheForTests();
  clearModelsCacheForTests();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    data: [
      { id: "grok-4.5", object: "model" },
      { id: "review-model", object: "model" },
    ],
  });

  let captured;
  try {
    captured = await captureLogs(() => worker.fetch(
      new Request("https://gateway.example/v1/models", {
        headers: { authorization: "Bearer client-key", "user-agent": "OpenAI-SDK" },
      }),
      testEnv(gatewayConfig()),
      {},
    ));
    assert.equal(captured.value.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(captured.entries.length, 1);
  const [entry] = captured.entries;
  assert.equal(entry.event, "request.summary");
  assert.deepEqual(entry.routing.candidate_services, ["primary"]);
  assert.deepEqual(entry.routing.selected_keys, [
    { service_id: "primary", key_id: "primary-key" },
  ]);
  assert.deepEqual(entry.routing.checked_available_services, ["primary"]);
  assert.equal(entry.routing.service_checks[0].key_id, "primary-key");
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
    keys: [{
      id: "secondary-key",
      api_key: "secondary-key",
      disabled: false,
      priority: 50,
    }],
    disabled: false,
    priority: 50,
    models: ["grok-4.5"],
  });
  config.api_keys[0].services.push("secondary");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.url.startsWith("https://primary.example/")) {
      return Response.json({ error: { code: "primary_unavailable" } }, { status: 500 });
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
      keys: [{
        id: `service-key-${index}`,
        api_key: `upstream-${index}`,
        disabled: false,
        priority: 100 - index,
      }],
      disabled: false,
      priority: 100 - index,
      models: ["grok-4.5"],
    });
    config.api_keys[0].services.push(`service-${index}`);
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    return Response.json({
      error: {
        service: new URL(request.url).hostname,
        detail: "x".repeat(20 * 1024),
      },
    }, { status: 500 });
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
  assert.equal(Object.hasOwn(entry.catalog.upstream_errors[0], "error_json"), true);
  assert.equal(
    entry.catalog.upstream_errors
      .slice(1)
      .every((upstream) => upstream.error_json_omitted === "request_log_budget_exceeded"),
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
      pending.push(worker.fetch(
        new Request("https://gateway.example/v1/models", {
          headers: { authorization: "Bearer client-key", "user-agent": "OpenAI-SDK" },
        }),
        env,
        {},
      ));
    }

    await Promise.race([
      twoCalls,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("concurrent model requests shared one upstream operation")),
          2_000,
        );
      }),
    ]);
    assert.equal(calls, 2);
    releaseUpstream();
    const responses = await Promise.all(pending);
    assert.deepEqual(responses.map((response) => response.status), [200, 200]);
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
    keys: [{
      id: "secondary-key",
      api_key: "secondary-key",
      disabled: false,
      priority: 50,
    }],
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
    keys: [{
      id: "secondary-key",
      api_key: "secondary-key",
      disabled: false,
      priority: 50,
    }],
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
  globalThis.fetch = async () => new Response(
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
          timer = setTimeout(() => reject(new Error("response waited for log body")), 250);
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
  globalThis.fetch = async () => new Response("temporary upstream failure", {
    status: 502,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

  let captured;
  try {
    captured = await captureLogs(() => worker.fetch(
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
    ));
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
    keys: [{
      id: "secondary-key",
      api_key: "secondary-key",
      disabled: false,
      priority: 50,
    }],
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
