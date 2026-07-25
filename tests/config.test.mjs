import assert from "node:assert/strict";
import test from "node:test";

import { ConfigError, parseConfig } from "../src/config.ts";

function validConfig() {
  return {
    services: [
      {
        id: "primary",
        base_url: "https://primary.example/v1/",
        api_key: "upstream-key",
        priority: 100,
        models: ["grok-4.5", "review-model"],
      },
    ],
    api_keys: [{ api_key: "client-key", services: ["primary"] }],
    model_aliases: { "gpt-5.6-sol": "grok-4.5" },
    codex_auto_review: { service: "primary", model: "review-model" },
  };
}

test("parseConfig normalizes and validates a complete configuration", () => {
  const config = parseConfig(validConfig());
  assert.equal(config.services[0].base_url, "https://primary.example/v1");
  assert.equal(config.model_aliases["gpt-5.6-sol"], "grok-4.5");
});

test("parseConfig treats the optional model_aliases field as an empty mapping", () => {
  const input = validConfig();
  delete input.model_aliases;
  const config = parseConfig(input);
  assert.deepEqual(config.model_aliases, {});
});

test("parseConfig rejects aliases that no service can run", () => {
  const input = validConfig();
  input.model_aliases["gpt-5.6-sol"] = "missing-model";
  assert.throws(() => parseConfig(input), ConfigError);
});

test("parseConfig rejects a service list written with only the client alias", () => {
  const input = validConfig();
  input.services[0].models = ["gpt-5.6-sol", "review-model"];
  assert.throws(() => parseConfig(input), ConfigError);
});

test("parseConfig rejects an alias even when its real target is also listed", () => {
  const input = validConfig();
  input.services[0].models = ["gpt-5.6-sol", "grok-4.5", "review-model"];
  assert.throws(() => parseConfig(input), ConfigError);
});

test("parseConfig rejects API keys that reference unknown services", () => {
  const input = validConfig();
  input.api_keys[0].services = ["missing"];
  assert.throws(() => parseConfig(input), ConfigError);
});
