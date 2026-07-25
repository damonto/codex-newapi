import assert from "node:assert/strict";
import test from "node:test";

import { forwardRequestHeaders } from "../src/http.ts";
import { rewriteModel } from "../src/proxy.ts";

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
