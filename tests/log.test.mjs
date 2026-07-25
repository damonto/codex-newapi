import assert from "node:assert/strict";
import test from "node:test";

import {
  configureLogging,
  errorMessage,
  logInfo,
  logWarn,
} from "../src/log.ts";

test("logging honors production levels and redacts credentials", () => {
  const original = {
    log: console.log,
    warn: console.warn,
  };
  const lines = [];
  console.log = (...args) => lines.push(["info", ...args].join(" "));
  console.warn = (...args) => lines.push(["warn", ...args].join(" "));
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
  assert.equal(lines.length, 1);
  assert(lines[0].includes("[REDACTED]"));
  assert(!lines[0].includes("client-secret"));
  assert(!lines[0].includes("secret-value"));
  assert(!lines[0].includes('"ignored"'));
});
