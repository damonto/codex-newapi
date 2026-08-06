import assert from "node:assert/strict";
import test from "node:test";

import { ConfigError, parseConfig } from "../src/config.ts";

function validConfig() {
  return {
    services: [
      {
        id: "primary",
        base_url: "https://primary.example/v1/",
        keys: [
          {
            id: "primary-key",
            api_key: "upstream-key",
            disabled: false,
            priority: 100,
          },
        ],
        disabled: false,
        priority: 100,
        models: ["grok-4.5", "review-model"],
      },
    ],
    api_keys: [{ api_key: "client-key", services: ["primary"] }],
    model_routes: {
      "gpt-5.6-sol": { model: "grok-4.5" },
      "codex-auto-review": { model: "review-model", services: ["primary"] },
    },
  };
}

test("parseConfig normalizes and validates a complete configuration", () => {
  const config = parseConfig(validConfig());
  assert.equal(config.services[0].base_url, "https://primary.example/v1");
  assert.equal(config.services[0].disabled, false);
  assert.equal(config.services[0].supports_websocket, false);
  assert.equal(config.services[0].supports_web_search, false);
  assert.deepEqual(config.services[0].keys, [
    {
      id: "primary-key",
      api_key: "upstream-key",
      disabled: false,
      priority: 100,
    },
  ]);
  assert.equal(config.services[0].retry, undefined);
  assert.equal(Object.hasOwn(config.services[0], "retry"), false);
  assert.deepEqual(config.model_routes["gpt-5.6-sol"], { model: "grok-4.5" });
  assert.deepEqual(config.model_routes["codex-auto-review"], {
    model: "review-model",
    services: ["primary"],
  });
});

test("parseConfig accepts explicit service capability flags", () => {
  const input = validConfig();
  input.services[0].supports_websocket = true;
  input.services[0].supports_web_search = false;

  const config = parseConfig(input);
  assert.equal(config.services[0].supports_websocket, true);
  assert.equal(config.services[0].supports_web_search, false);
});

test("parseConfig rejects non-boolean service capability flags", () => {
  for (const field of ["supports_websocket", "supports_web_search"]) {
    const input = validConfig();
    input.services[0][field] = "true";
    assert.throws(
      () => parseConfig(input),
      (error) =>
        error instanceof ConfigError &&
        error.message === `services[0].${field} must be a boolean`,
    );
  }
});

test("parseConfig accepts multiple service keys in configuration order", () => {
  const input = validConfig();
  input.services[0].keys.push({
    id: "backup-key",
    api_key: "backup-upstream-key",
    disabled: true,
    priority: 50,
  });

  const config = parseConfig(input);
  assert.deepEqual(
    config.services[0].keys.map((key) => key.id),
    ["primary-key", "backup-key"],
  );
});

test("parseConfig requires a non-empty service keys array", () => {
  for (const keys of [undefined, []]) {
    const input = validConfig();
    if (keys === undefined) {
      delete input.services[0].keys;
    } else {
      input.services[0].keys = keys;
    }
    assert.throws(
      () => parseConfig(input),
      (error) =>
        error instanceof ConfigError &&
        error.message === "services[0].keys must be a non-empty array",
    );
  }
});

test("parseConfig validates service key fields and identifiers", () => {
  const cases = [
    ["services[0].keys[0].id contains unsupported characters", (key) => {
      key.id = "bad key";
    }],
    ["services[0].keys[0].api_key must be a non-empty string", (key) => {
      key.api_key = "";
    }],
    ["services[0].keys[0].disabled must be a boolean", (key) => {
      key.disabled = "false";
    }],
    ["services[0].keys[0].priority must be an integer", (key) => {
      key.priority = 1.5;
    }],
  ];

  for (const [message, mutate] of cases) {
    const input = validConfig();
    mutate(input.services[0].keys[0]);
    assert.throws(
      () => parseConfig(input),
      (error) => error instanceof ConfigError && error.message === message,
    );
  }
});

test("parseConfig requires service key ids to be unique within a service", () => {
  const input = validConfig();
  input.services[0].keys.push({
    ...input.services[0].keys[0],
    api_key: "another-upstream-key",
  });
  assert.throws(
    () => parseConfig(input),
    (error) =>
      error instanceof ConfigError &&
      error.message === "services[0].keys.id values must be unique",
  );
});

test("parseConfig rejects the removed service api_key field", () => {
  const input = validConfig();
  input.services[0].api_key = "legacy-upstream-key";
  assert.throws(
    () => parseConfig(input),
    (error) =>
      error instanceof ConfigError &&
      error.message === "services[0].api_key is not supported",
  );
});

test("parseConfig allows codex-auto-review as the configured upstream model", () => {
  const input = validConfig();
  input.services[0].models = ["grok-4.5", "codex-auto-review"];
  input.model_routes["codex-auto-review"].model = "codex-auto-review";

  const config = parseConfig(input);
  assert.equal(config.model_routes["codex-auto-review"].model, "codex-auto-review");
});

test("parseConfig enables retries only when a service configures them", () => {
  const input = validConfig();
  input.services[0].retry = {
    status_codes: [429, 503],
    delays_ms: [250, 500, 1000],
  };

  const config = parseConfig(input);
  assert.deepEqual(config.services[0].retry, input.services[0].retry);
});

test("parseConfig accepts empty retry arrays to disable an explicit policy", () => {
  const input = validConfig();
  input.services[0].retry = { status_codes: [], delays_ms: [] };
  const config = parseConfig(input);
  assert.deepEqual(config.services[0].retry, input.services[0].retry);
});

test("parseConfig rejects invalid retry policies", () => {
  const cases = [
    [
      "services[0].retry.status_codes[0] must be between 400 and 599",
      { status_codes: [399], delays_ms: [100] },
    ],
    [
      "services[0].retry.status_codes must not contain duplicates",
      { status_codes: [429, 429], delays_ms: [100] },
    ],
    [
      "services[0].retry.delays_ms[0] must be between 0 and 60000",
      { status_codes: [429], delays_ms: [-1] },
    ],
    [
      "services[0].retry.delays_ms must contain at most 10 items",
      { status_codes: [429], delays_ms: Array.from({ length: 11 }, () => 0) },
    ],
    [
      "services[0].retry.status_codes and services[0].retry.delays_ms must both be empty or both be non-empty",
      { status_codes: [429], delays_ms: [] },
    ],
  ];

  for (const [message, retry] of cases) {
    const input = validConfig();
    input.services[0].retry = retry;
    assert.throws(
      () => parseConfig(input),
      (error) => error instanceof ConfigError && error.message === message,
    );
  }
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

test("parseConfig treats the optional model_routes field as an empty mapping", () => {
  const input = validConfig();
  delete input.model_routes;
  const config = parseConfig(input);
  assert.deepEqual(config.model_routes, {});
});

test("parseConfig rejects the removed legacy routing fields", () => {
  const aliases = validConfig();
  aliases.model_aliases = { "gpt-5.6-sol": "grok-4.5" };
  assert.throws(
    () => parseConfig(aliases),
    (error) =>
      error instanceof ConfigError &&
      error.message === "configuration.model_aliases is not supported",
  );

  const autoReview = validConfig();
  autoReview.codex_auto_review = { service: "primary", model: "review-model" };
  assert.throws(
    () => parseConfig(autoReview),
    (error) =>
      error instanceof ConfigError &&
      error.message === "configuration.codex_auto_review is not supported",
  );
});

test("parseConfig rejects routes that no service can run", () => {
  const input = validConfig();
  input.model_routes["gpt-5.6-sol"].model = "missing-model";
  assert.throws(
    () => parseConfig(input),
    (error) =>
      error instanceof ConfigError &&
      error.message ===
        "model_routes.gpt-5.6-sol.model targets missing-model, which no service supports",
  );
});

test("parseConfig requires services to list the real route target", () => {
  const input = validConfig();
  input.services[0].models = ["gpt-5.6-sol", "review-model"];
  assert.throws(() => parseConfig(input), ConfigError);
});

test("parseConfig allows a route to constrain a real model name", () => {
  const input = validConfig();
  input.model_routes = {
    "grok-4.5": { model: "grok-4.5", services: ["primary"] },
  };
  assert.doesNotThrow(() => parseConfig(input));
});

test("parseConfig rejects unknown or incompatible route services", () => {
  const unknown = validConfig();
  unknown.model_routes["gpt-5.6-sol"].services = ["missing"];
  assert.throws(
    () => parseConfig(unknown),
    (error) =>
      error instanceof ConfigError &&
      error.message ===
        "model_routes.gpt-5.6-sol.services references unknown service missing",
  );

  const unsupported = validConfig();
  unsupported.services.push({
    id: "secondary",
    base_url: "https://secondary.example/v1",
    keys: [{
      id: "secondary-key",
      api_key: "secondary-key",
      disabled: false,
      priority: 50,
    }],
    disabled: false,
    priority: 50,
    models: ["review-model"],
  });
  unsupported.model_routes["gpt-5.6-sol"].services = ["secondary"];
  assert.throws(
    () => parseConfig(unsupported),
    (error) =>
      error instanceof ConfigError &&
      error.message ===
        "model_routes.gpt-5.6-sol.model grok-4.5 is not listed by service secondary",
  );
});

test("parseConfig rejects empty or duplicate route service constraints", () => {
  for (const services of [[], ["primary", "primary"]]) {
    const input = validConfig();
    input.model_routes["gpt-5.6-sol"].services = services;
    assert.throws(() => parseConfig(input), ConfigError);
  }
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
    ["services[0].retry.extra is not supported", (input) => {
      input.services[0].retry = {
        status_codes: [429],
        delays_ms: [250],
        extra: true,
      };
    }],
    ["services[0].keys[0].extra is not supported", (input) => {
      input.services[0].keys[0].extra = true;
    }],
    ["api_keys[0].extra is not supported", (input) => {
      input.api_keys[0].extra = true;
    }],
    ["model_routes.gpt-5.6-sol.extra is not supported", (input) => {
      input.model_routes["gpt-5.6-sol"].extra = true;
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
