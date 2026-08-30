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
    api_keys: [{ id: "client", api_key: "client-key", services: ["primary"] }],
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
  assert.deepEqual(config.api_keys[0], {
    id: "client",
    api_key: "client-key",
    services: ["primary"],
  });
  assert.deepEqual(config.model_routes["gpt-5.6-sol"], { model: "grok-4.5" });
  assert.deepEqual(config.model_routes["codex-auto-review"], {
    model: "review-model",
    services: ["primary"],
  });
  assert.deepEqual(config.web_search, { mode: "proxy" });
});

test("parseConfig selects an explicit web search mode", () => {
  for (const [mode, baseUrl] of [
    ["tavily", "https://api.tavily.com"],
    ["exa", "https://api.exa.ai"],
  ]) {
    const input = validConfig();
    input.web_search = { mode, api_key: `${mode}-key` };
    assert.deepEqual(parseConfig(input).web_search, {
      mode,
      base_url: baseUrl,
      api_key: `${mode}-key`,
      max_results: mode === "tavily" ? 5 : 10,
    });
  }
});

test("parseConfig accepts provider-specific web search result limits", () => {
  for (const [mode, maxResults] of [
    ["tavily", 0],
    ["exa", 100],
  ]) {
    const input = validConfig();
    input.web_search = {
      mode,
      api_key: `${mode}-key`,
      max_results: maxResults,
    };
    assert.equal(parseConfig(input).web_search.max_results, maxResults);
  }
});

test("parseConfig validates explicit web search settings", () => {
  const cases = [
    [
      "web_search.mode must be proxy or one of: tavily, exa",
      { mode: "fallback" },
    ],
    ["web_search.api_key must be a non-empty string", { mode: "tavily" }],
    [
      "web_search.max_results must be between 0 and 20 for tavily",
      { mode: "tavily", api_key: "tavily-key", max_results: 21 },
    ],
    [
      "web_search.max_results must be between 1 and 100 for exa",
      { mode: "exa", api_key: "exa-key", max_results: 0 },
    ],
    [
      "web_search.api_key is only supported for Tavily or Exa mode",
      { mode: "proxy", api_key: "unexpected" },
    ],
    ["web_search.extra is not supported", { mode: "proxy", extra: true }],
  ];
  for (const [message, webSearch] of cases) {
    const input = validConfig();
    input.web_search = webSearch;
    assert.throws(
      () => parseConfig(input),
      (error) => error instanceof ConfigError && error.message === message,
    );
  }
});

test("parseConfig accepts explicit service capability flags", () => {
  const input = validConfig();
  input.services[0].supports_websocket = true;
  input.services[0].supports_web_search = false;
  input.services[0].inject_claude_code_identity = true;

  const config = parseConfig(input);
  assert.equal(config.services[0].supports_websocket, true);
  assert.equal(config.services[0].supports_web_search, false);
  assert.equal(config.services[0].inject_claude_code_identity, true);
});

test("parseConfig rejects a service protocol field", () => {
  // A service may serve either dialect, so the dialect is derived per request
  // and cannot be declared here.
  const input = validConfig();
  input.services[0].protocol = "anthropic";
  assert.throws(
    () => parseConfig(input),
    (error) =>
      error instanceof ConfigError &&
      error.message === "services[0].protocol is not supported",
  );
});

test("parseConfig rejects non-boolean service capability flags", () => {
  for (const field of [
    "supports_websocket",
    "supports_web_search",
    "inject_claude_code_identity",
  ]) {
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
    [
      "services[0].keys[0].id contains unsupported characters",
      (key) => {
        key.id = "bad key";
      },
    ],
    [
      "services[0].keys[0].api_key must be a non-empty string",
      (key) => {
        key.api_key = "";
      },
    ],
    [
      "services[0].keys[0].disabled must be a boolean",
      (key) => {
        key.disabled = "false";
      },
    ],
    [
      "services[0].keys[0].priority must be an integer",
      (key) => {
        key.priority = 1.5;
      },
    ],
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
  assert.equal(
    config.model_routes["codex-auto-review"].model,
    "codex-auto-review",
  );
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
    (error) =>
      error instanceof ConfigError &&
      error.message === "services[0].disabled must be a boolean",
  );
});

test("parseConfig rejects a non-boolean disabled value", () => {
  const input = validConfig();
  input.services[0].disabled = "false";
  assert.throws(
    () => parseConfig(input),
    (error) =>
      error instanceof ConfigError &&
      error.message === "services[0].disabled must be a boolean",
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

test("parseConfig accepts per-key model routes alongside global routes", () => {
  const input = validConfig();
  input.api_keys[0].model_routes = {
    "gpt-5.6-sol": { model: "review-model", services: ["primary"] },
  };

  const config = parseConfig(input);
  assert.equal(Object.hasOwn(config.api_keys[0], "model_routes"), true);
  assert.deepEqual(config.api_keys[0].model_routes, {
    "gpt-5.6-sol": { model: "review-model", services: ["primary"] },
  });
  assert.deepEqual(config.model_routes["gpt-5.6-sol"], { model: "grok-4.5" });
});

test("parseConfig accepts service model routes without a services field", () => {
  const input = validConfig();
  input.services[0].model_routes = {
    "gpt-5.6-sol": { model: "review-model" },
  };

  const config = parseConfig(input);
  assert.equal(Object.hasOwn(config.services[0], "model_routes"), true);
  assert.deepEqual(config.services[0].model_routes, {
    "gpt-5.6-sol": { model: "review-model" },
  });
});

test("parseConfig omits the service model_routes field when absent or empty", () => {
  for (const modelRoutes of [undefined, {}]) {
    const input = validConfig();
    if (modelRoutes === undefined) {
      delete input.services[0].model_routes;
    } else {
      input.services[0].model_routes = modelRoutes;
    }
    const config = parseConfig(input);
    assert.equal(Object.hasOwn(config.services[0], "model_routes"), false);
  }
});

test("parseConfig rejects service route services constraints", () => {
  const input = validConfig();
  input.services[0].model_routes = {
    "gpt-5.6-sol": { model: "review-model", services: ["primary"] },
  };
  assert.throws(
    () => parseConfig(input),
    (error) =>
      error instanceof ConfigError &&
      error.message ===
        "services[0].model_routes.gpt-5.6-sol.services is not supported",
  );
});

test("parseConfig requires service routes to list models the service supports", () => {
  const input = validConfig();
  input.services[0].model_routes = {
    "gpt-5.6-sol": { model: "missing-model" },
  };
  assert.throws(
    () => parseConfig(input),
    (error) =>
      error instanceof ConfigError &&
      error.message ===
        "services[0].model_routes.gpt-5.6-sol.model missing-model is not listed by service primary",
  );
});

test("parseConfig rejects duplicate normalized service route models", () => {
  const input = validConfig();
  input.services[0].model_routes = {
    "gpt-5.6-sol": { model: "review-model" },
    "gpt-5.6-sol ": { model: "review-model" },
  };
  assert.throws(
    () => parseConfig(input),
    (error) =>
      error instanceof ConfigError &&
      error.message ===
        "services[0].model_routes contains duplicate normalized model gpt-5.6-sol",
  );
});

test("parseConfig omits the per-key model_routes field when absent or empty", () => {
  for (const modelRoutes of [undefined, {}]) {
    const input = validConfig();
    if (modelRoutes === undefined) {
      delete input.api_keys[0].model_routes;
    } else {
      input.api_keys[0].model_routes = modelRoutes;
    }
    const config = parseConfig(input);
    assert.equal(Object.hasOwn(config.api_keys[0], "model_routes"), false);
  }
});

test("parseConfig validates per-key route targets and services", () => {
  const unknown = validConfig();
  unknown.api_keys[0].model_routes = {
    "gpt-5.6-sol": { model: "grok-4.5", services: ["missing"] },
  };
  assert.throws(
    () => parseConfig(unknown),
    (error) =>
      error instanceof ConfigError &&
      error.message ===
        "api_keys[0].model_routes.gpt-5.6-sol.services references unknown service missing",
  );

  const unsupported = validConfig();
  unsupported.services.push({
    id: "secondary",
    base_url: "https://secondary.example/v1",
    keys: [
      {
        id: "secondary-key",
        api_key: "secondary-key",
        disabled: false,
        priority: 50,
      },
    ],
    disabled: false,
    priority: 50,
    models: ["review-model"],
  });
  unsupported.api_keys[0].model_routes = {
    "gpt-5.6-sol": { model: "grok-4.5", services: ["secondary"] },
  };
  assert.throws(
    () => parseConfig(unsupported),
    (error) =>
      error instanceof ConfigError &&
      error.message ===
        "api_keys[0].model_routes.gpt-5.6-sol.model grok-4.5 is not listed by service secondary",
  );
});

test("parseConfig rejects per-key routes that no service can run", () => {
  const input = validConfig();
  input.api_keys[0].model_routes = {
    "gpt-5.6-sol": { model: "missing-model" },
  };
  assert.throws(
    () => parseConfig(input),
    (error) =>
      error instanceof ConfigError &&
      error.message ===
        "api_keys[0].model_routes.gpt-5.6-sol.model targets missing-model, which no service supports",
  );
});

test("parseConfig rejects invalid per-key route fields and constraints", () => {
  const extra = validConfig();
  extra.api_keys[0].model_routes = {
    "gpt-5.6-sol": { model: "grok-4.5", extra: true },
  };
  assert.throws(
    () => parseConfig(extra),
    (error) =>
      error instanceof ConfigError &&
      error.message ===
        "api_keys[0].model_routes.gpt-5.6-sol.extra is not supported",
  );

  for (const services of [[], ["primary", "primary"]]) {
    const input = validConfig();
    input.api_keys[0].model_routes = {
      "gpt-5.6-sol": { model: "grok-4.5", services },
    };
    assert.throws(
      () => parseConfig(input),
      (error) => error instanceof ConfigError,
    );
  }

  const duplicate = validConfig();
  duplicate.api_keys[0].model_routes = {};
  duplicate.api_keys[0].model_routes["gpt-5.6-sol"] = { model: "grok-4.5" };
  duplicate.api_keys[0].model_routes["gpt-5.6-sol "] = { model: "grok-4.5" };
  assert.throws(
    () => parseConfig(duplicate),
    (error) =>
      error instanceof ConfigError &&
      error.message ===
        "api_keys[0].model_routes contains duplicate normalized model gpt-5.6-sol",
  );
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
    keys: [
      {
        id: "secondary-key",
        api_key: "secondary-key",
        disabled: false,
        priority: 50,
      },
    ],
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

test("parseConfig requires valid, globally unique client API key ids", () => {
  const cases = [
    [
      "api_keys[0].id must be a non-empty string",
      (input) => {
        delete input.api_keys[0].id;
      },
    ],
    [
      "api_keys[0].id contains unsupported characters",
      (input) => {
        input.api_keys[0].id = "bad key";
      },
    ],
    [
      "api_keys[0].id contains unsupported characters",
      (input) => {
        input.api_keys[0].id = " client ";
      },
    ],
  ];

  for (const [message, mutate] of cases) {
    const input = validConfig();
    mutate(input);
    assert.throws(
      () => parseConfig(input),
      (error) => error instanceof ConfigError && error.message === message,
    );
  }

  const duplicate = validConfig();
  duplicate.api_keys.push({
    ...duplicate.api_keys[0],
    api_key: "other-client-key",
  });
  assert.throws(
    () => parseConfig(duplicate),
    (error) =>
      error instanceof ConfigError &&
      error.message === "api_keys.id values must be unique",
  );
});

test("parseConfig rejects fields that are not declared by the schema", () => {
  const cases = [
    [
      "configuration.extra is not supported",
      (input) => {
        input.extra = true;
      },
    ],
    [
      "services[0].extra is not supported",
      (input) => {
        input.services[0].extra = true;
      },
    ],
    [
      "services[0].model_routes.gpt-5.6-sol.extra is not supported",
      (input) => {
        input.services[0].model_routes = {
          "gpt-5.6-sol": { model: "review-model", extra: true },
        };
      },
    ],
    [
      "services[0].retry.extra is not supported",
      (input) => {
        input.services[0].retry = {
          status_codes: [429],
          delays_ms: [250],
          extra: true,
        };
      },
    ],
    [
      "services[0].keys[0].extra is not supported",
      (input) => {
        input.services[0].keys[0].extra = true;
      },
    ],
    [
      "api_keys[0].extra is not supported",
      (input) => {
        input.api_keys[0].extra = true;
      },
    ],
    [
      "model_routes.gpt-5.6-sol.extra is not supported",
      (input) => {
        input.model_routes["gpt-5.6-sol"].extra = true;
      },
    ],
    [
      "api_keys[0].model_routes.gpt-5.6-sol.extra is not supported",
      (input) => {
        input.api_keys[0].model_routes = {
          "gpt-5.6-sol": { model: "grok-4.5", extra: true },
        };
      },
    ],
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
      error instanceof ConfigError &&
      error.message === "configuration.$schema must be a string",
  );
});
