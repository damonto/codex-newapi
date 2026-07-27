import assert from "node:assert/strict";
import test from "node:test";

import { findClientApiKey, forwardRequestHeaders } from "../src/http.ts";
import {
  handleInference,
  rewriteModel,
} from "../src/proxy.ts";

function inferenceFixture(retry) {
  const service = {
    id: "primary",
    base_url: "https://primary.example/v1",
    api_key: "service-secret-key",
    disabled: false,
    priority: 100,
    models: ["model"],
    ...(retry === undefined ? {} : { retry }),
  };
  const calls = { failure: 0, success: 0 };
  const snapshot = { failures: 0, cooling_until: null };
  return {
    calls,
    client: { api_key: "client", services: [service.id] },
    config: {
      services: [service],
      api_keys: [{ api_key: "client", services: [service.id] }],
      model_aliases: {},
      codex_auto_review: { service: service.id, model: "model" },
    },
    env: {
      HEALTH: {
        getByName: () => ({
          getStatus: async () => snapshot,
          recordFailure: async () => {
            calls.failure += 1;
            return snapshot;
          },
          recordSuccess: async () => {
            calls.success += 1;
            return snapshot;
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

test("request JSON stays byte-for-byte equivalent when no mapping is needed", () => {
  const original = '{\n  "model": "grok-4.5",\n  "stream": true\n}';
  assert.equal(rewriteModel(original, JSON.parse(original), "grok-4.5"), original);
});

test("mapping changes only the model value semantically", () => {
  const original = '{"model":"gpt-5.6-sol","stream":true,"input":"hello"}';
  const rewritten = JSON.parse(rewriteModel(original, JSON.parse(original), "grok-4.5"));
  assert.deepEqual(rewritten, { model: "grok-4.5", stream: true, input: "hello" });
});

test("Responses bodies remain unchanged when image generation is routable", async () => {
  const fixture = inferenceFixture();
  fixture.config.services[0].models.push("upstream-image-model");
  fixture.config.model_aliases["gpt-image-2"] = "upstream-image-model";
  const originalBody = '{\n  "model": "model",\n  "input": "draw",\n  "tools": []\n}\n';
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

test("Image API requests route gpt-image-2 through its model alias", async () => {
  const originalFetch = globalThis.fetch;
  const fixture = inferenceFixture();
  fixture.config.services[0].models = ["upstream-image-model"];
  fixture.config.model_aliases = { "gpt-image-2": "upstream-image-model" };
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

test("model aliases rewrite only the model and invalidate body digests", async () => {
  const fixture = inferenceFixture();
  fixture.config.services[0].models = ["upstream-model"];
  fixture.config.model_aliases = { "client-model": "upstream-model" };
  fixture.config.codex_auto_review.model = "upstream-model";
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
  assert.equal(headers.get("content-length"), null);
  assert.equal(headers.get("x-tenant"), "tenant-a");
  assert.equal(headers.get("content-type"), "application/json");
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
    { api_key: "first-key", services: ["first"] },
    { api_key: "matching-key", services: ["second"] },
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
      assert.equal(fixture.calls.success, 0);
    }
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
    assert(requests.every((request) => request.url === "https://primary.example/v1/responses"));
    assert(requests.every((request) => request.method === "POST"));
    assert(requests.every((request) => request.authorization === "Bearer service-secret-key"));
    const expectedBody = JSON.stringify({ model: "model", input: "hello" });
    assert(requests.every((request) => request.body === expectedBody));
    assert.equal(fixture.calls.failure, 0);
    assert.equal(fixture.calls.success, 1);
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
