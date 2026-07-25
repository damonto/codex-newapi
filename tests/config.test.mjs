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
        disabled: false,
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
  assert.equal(config.services[0].disabled, false);
  assert.equal(config.model_aliases["gpt-5.6-sol"], "grok-4.5");
});

test("parseConfig requires services to explicitly declare disabled", () => {
  const input = validConfig();
  delete input.services[0].disabled;
  assert.throws(
    () => parseConfig(input),
    (error) => error instanceof ConfigError && error.message === "services[0].disabled must be a boolean",
  );
});

test("parseConfig rejects a non-boolean disabled value", () => {
  const input = validConfig();
  input.services[0].disabled = "false";
  assert.throws(
    () => parseConfig(input),
    (error) => error instanceof ConfigError && error.message === "services[0].disabled must be a boolean",
  );
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

test("parseConfig rejects fields that are not declared by the schema", () => {
  const cases = [
    ["configuration.extra is not supported", (input) => {
      input.extra = true;
    }],
    ["services[0].extra is not supported", (input) => {
      input.services[0].extra = true;
    }],
    ["api_keys[0].extra is not supported", (input) => {
      input.api_keys[0].extra = true;
    }],
    ["codex_auto_review.extra is not supported", (input) => {
      input.codex_auto_review.extra = true;
    }],
  ];

  for (const [message, mutate] of cases) {
    const input = validConfig();
    mutate(input);
    assert.throws(
      () => parseConfig(input),
      (error) => error instanceof ConfigError && error.message === message,
    );
  }
});

test("parseConfig accepts a string $schema field and rejects other types", () => {
  const input = validConfig();
  input.$schema = "./config.schema.json";
  assert.doesNotThrow(() => parseConfig(input));

  input.$schema = true;
  assert.throws(
    () => parseConfig(input),
    (error) =>
      error instanceof ConfigError && error.message === "configuration.$schema must be a string",
  );
});
