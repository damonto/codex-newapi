import assert from "node:assert/strict";
import test from "node:test";

import { BodyTooLargeError, readBodyWithinLimit } from "../src/body.ts";
import { handleInference, MAX_INFERENCE_BODY_BYTES } from "../src/proxy.ts";

const encoder = new TextEncoder();

test("bounded body reading accepts a stream exactly at the limit", async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("123"));
      controller.enqueue(encoder.encode("45"));
      controller.close();
    },
  });

  const body = await readBodyWithinLimit(stream, 5);
  assert.equal(new TextDecoder().decode(body), "12345");
});

test("bounded body reading rejects and cancels a stream that exceeds the actual limit", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("1234"));
      controller.enqueue(encoder.encode("56"));
    },
    cancel() {
      cancelled = true;
    },
  });

  await assert.rejects(
    readBodyWithinLimit(stream, 5),
    (error) => error instanceof BodyTooLargeError && error.maxBytes === 5,
  );
  assert.equal(cancelled, true);
});

test("bounded body reading rejects declared oversize bodies before consuming them", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });

  await assert.rejects(
    readBodyWithinLimit(stream, 5, "6"),
    (error) => error instanceof BodyTooLargeError && error.maxBytes === 5,
  );
  assert.equal(cancelled, true);
});

test("inference requests larger than 96 MiB return an OpenAI-compatible 413", async () => {
  assert.equal(MAX_INFERENCE_BODY_BYTES, 96 * 1024 * 1024);
  const request = new Request("https://gateway.example/v1/responses", {
    method: "POST",
    headers: {
      "content-length": String(MAX_INFERENCE_BODY_BYTES + 1),
      "content-type": "application/json",
    },
    body: "{}",
  });
  const response = await handleInference(
    request,
    {},
    {
      services: [],
      api_keys: [],
      model_routes: {},
    },
    { api_key: "client", services: [] },
    "responses",
  );

  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, "request_too_large");
});
