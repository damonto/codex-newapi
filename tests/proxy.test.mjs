import assert from "node:assert/strict";
import test from "node:test";

import { findClientApiKey, forwardRequestHeaders } from "../src/http.ts";
import { handleInference, rewriteModel } from "../src/proxy.ts";

function inferenceFixture() {
  const service = {
    id: "primary",
    base_url: "https://primary.example/v1",
    api_key: "service-secret-key",
    disabled: false,
    priority: 100,
    models: ["model"],
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

test("forwarding removes proxy metadata and client credentials", () => {
  const request = new Request("https://gateway.example/v1/responses", {
    headers: {
      authorization: "Bearer client",
      cookie: "session=secret",
      forwarded: "for=127.0.0.1",
      "x-forwarded-for": "127.0.0.1",
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
  assert.equal(headers.get("x-api-key"), null);
  assert.equal(headers.get("content-length"), null);
  assert.equal(headers.get("x-tenant"), "tenant-a");
  assert.equal(headers.get("content-type"), "application/json");
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
      );
      assert.equal(response.status, status);
      assert.equal(fixture.calls.failure, expectedFailures);
      assert.equal(fixture.calls.success, 0);
    }
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
