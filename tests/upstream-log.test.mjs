import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_LOGGED_UPSTREAM_ERROR_BYTES,
  upstreamResponseLogFields,
} from "../src/upstream-log.ts";

test("oversized upstream JSON is omitted without consuming the original response", async () => {
  const body = JSON.stringify({
    error: "x".repeat(MAX_LOGGED_UPSTREAM_ERROR_BYTES),
  });
  const response = new Response(body, {
    status: 500,
    headers: {
      "content-length": String(new TextEncoder().encode(body).byteLength),
      "content-type": "application/json",
    },
  });

  const fields = await upstreamResponseLogFields(response);

  assert.equal(fields.status, 500);
  assert.equal(fields.error_json_omitted, "body_too_large");
  assert.equal(fields.error_body_limit_bytes, MAX_LOGGED_UPSTREAM_ERROR_BYTES);
  assert.equal(await response.text(), body);
});

test("non-JSON upstream errors record only the status code", async () => {
  const response = new Response("temporary failure", {
    status: 502,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-request-id": "upstream-request",
    },
  });

  const fields = await upstreamResponseLogFields(response);

  assert.deepEqual(fields, { status: 502 });
  assert.equal(await response.text(), "temporary failure");
});
