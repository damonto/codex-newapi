import assert from "node:assert/strict";
import test from "node:test";

import {
  configureLogging,
  errorMessage,
  logInfo,
  logWarn,
  RequestLogContext,
} from "../src/log.ts";

test("logging honors production levels and redacts credentials", () => {
  const original = {
    log: console.log,
    warn: console.warn,
  };
  const entries = [];
  console.log = (entry) => entries.push({ level: "info", entry });
  console.warn = (entry) => entries.push({ level: "warn", entry });
  try {
    configureLogging("warn");
    logInfo("ignored", { value: "not emitted" });
    logWarn("upstream.failed", {
      authorization: "Bearer client-secret",
      error: errorMessage(new Error("https://example.test/?api_key=secret-value")),
    });
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    configureLogging("info");
  }
  assert.equal(entries.length, 1);
  assert.equal(entries[0].level, "warn");
  const serialized = JSON.stringify(entries[0].entry);
  assert(serialized.includes("[REDACTED]"));
  assert(!serialized.includes("client-secret"));
  assert(!serialized.includes("secret-value"));
  assert(!serialized.includes('"ignored"'));
});

test("request logs emit one completion summary", () => {
  const original = {
    log: console.log,
    warn: console.warn,
  };
  const entries = [];
  console.log = (entry) => entries.push({ level: "info", entry });
  console.warn = (entry) => entries.push({ level: "warn", entry });
  try {
    configureLogging("info");
    const context = new RequestLogContext(
      "request-1",
      new Request("https://gateway.example/v1/responses?token=hidden", { method: "POST" }),
      "responses",
    );
    context.set({ routing: { selected_service: "primary" } });
    const response = new Response(null, { status: 429 });
    assert.equal(context.complete(response), response);
    assert.equal(context.complete(response), response);
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    configureLogging("info");
  }

  assert.equal(entries.length, 1);
  assert.equal(entries[0].level, "warn");
  const entry = entries[0].entry;
  assert.equal(entry.event, "request.summary");
  assert.equal(entry.request_id, "request-1");
  assert.equal(entry.path, "/v1/responses");
  assert.equal(entry.response_status, 429);
  assert.equal(entry.routing.selected_service, "primary");
  assert(!JSON.stringify(entry).includes("hidden"));
});

test("HTTP 5xx request summaries emit at error level", () => {
  const original = console.error;
  const entries = [];
  console.error = (entry) => entries.push(entry);
  try {
    configureLogging("error");
    const context = new RequestLogContext(
      "request-500",
      new Request("https://gateway.example/v1/responses", { method: "POST" }),
      "responses",
    );
    context.complete(new Response(null, { status: 500 }));
  } finally {
    console.error = original;
    configureLogging("info");
  }

  assert.equal(entries.length, 1);
  assert.equal(entries[0].event, "request.summary");
  assert.equal(entries[0].response_status, 500);
});

test("request logs cap the combined upstream error body budget", () => {
  const context = new RequestLogContext(
    "request-budget",
    new Request("https://gateway.example/v1/models"),
    "models",
  );
  const first = context.limitUpstreamErrorFields({
    status: 500,
    error_body_bytes: 20 * 1024,
    error_json: { error: "first" },
  });
  const second = context.limitUpstreamErrorFields({
    status: 500,
    error_body_bytes: 20 * 1024,
    error_json: { error: "second" },
  });

  assert.equal(Object.hasOwn(first, "error_json"), true);
  assert.equal(Object.hasOwn(second, "error_json"), false);
  assert.equal(second.error_json_omitted, "request_log_budget_exceeded");
});
