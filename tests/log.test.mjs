import assert from "node:assert/strict";
import test from "node:test";

import {
  configureLogging,
  errorMessage,
  logError,
  logInfo,
  logWarn,
  RequestLogContext,
} from "../src/log.ts";

test("logging honors production levels and redacts credentials", () => {
  const original = {
    info: console.info,
    warn: console.warn,
  };
  const entries = [];
  console.info = (entry) => entries.push({ level: "info", entry });
  console.warn = (entry) => entries.push({ level: "warn", entry });
  try {
    configureLogging("warn");
    logInfo("ignored", { value: "not emitted" });
    logWarn("upstream.failed", {
      authorization: "Bearer client-secret",
      error: errorMessage(new Error("https://example.test/?api_key=secret-value")),
    });
  } finally {
    console.info = original.info;
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

test("logging emits matching console methods and structured summary fields", () => {
  const original = {
    error: console.error,
    info: console.info,
    warn: console.warn,
  };
  const entries = [];
  console.info = (entry) => entries.push({ method: "info", entry });
  console.warn = (entry) => entries.push({ method: "warn", entry });
  console.error = (entry) => entries.push({ method: "error", entry });
  try {
    configureLogging("info");
    logInfo("request.succeeded", { level: "overridden", message: "overridden" });
    logWarn("request.delayed");
    logError("request.failed");
  } finally {
    console.error = original.error;
    console.info = original.info;
    console.warn = original.warn;
    configureLogging("info");
  }

  assert.deepEqual(entries.map(({ method }) => method), ["info", "warn", "error"]);
  assert.deepEqual(
    entries.map(({ entry }) => ({
      event: entry.event,
      level: entry.level,
      message: entry.message,
    })),
    [
      { event: "request.succeeded", level: "info", message: "request.succeeded" },
      { event: "request.delayed", level: "warn", message: "request.delayed" },
      { event: "request.failed", level: "error", message: "request.failed" },
    ],
  );
});

test("request logs emit one completion summary", () => {
  const original = {
    info: console.info,
    warn: console.warn,
  };
  const entries = [];
  console.info = (entry) => entries.push({ level: "info", entry });
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
    console.info = original.info;
    console.warn = original.warn;
    configureLogging("info");
  }

  assert.equal(entries.length, 1);
  assert.equal(entries[0].level, "warn");
  const entry = entries[0].entry;
  assert.equal(entry.event, "request.summary");
  assert.equal(entry.level, "warn");
  assert.equal(entry.message, "request.summary");
  assert.equal(entry.request_id, "request-1");
  assert.equal(entry.path, "/v1/responses");
  assert.equal(entry.response_status, 429);
  assert.equal(entry.routing.selected_service, "primary");
  assert(!JSON.stringify(entry).includes("hidden"));
});

test("request logs keep dynamic redaction values request-scoped without truncation", () => {
  const original = console.info;
  const entries = [];
  console.info = (entry) => entries.push(entry);
  try {
    configureLogging("info");
    const protectedContext = new RequestLogContext(
      "protected-request",
      new Request("https://gateway.example/v1/responses"),
      "responses",
    );
    protectedContext.registerSensitiveValues([
      ...Array.from({ length: 300 }, (_, index) => `long-opaque-value-${index}`),
      "xyz",
    ]);
    protectedContext.set({ detail: "dynamic value xyz" });
    protectedContext.complete(new Response(null, { status: 200 }));

    const independentContext = new RequestLogContext(
      "independent-request",
      new Request("https://gateway.example/v1/responses"),
      "responses",
    );
    independentContext.set({ detail: "dynamic value xyz" });
    independentContext.complete(new Response(null, { status: 200 }));
  } finally {
    console.info = original;
    configureLogging("info");
  }

  const protectedEntry = entries.find((entry) => entry.request_id === "protected-request");
  const independentEntry = entries.find((entry) => entry.request_id === "independent-request");
  assert.equal(protectedEntry.detail, "dynamic value [REDACTED]");
  assert.equal(independentEntry.detail, "dynamic value xyz");
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
  assert.equal(entries[0].level, "error");
  assert.equal(entries[0].message, "request.summary");
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
