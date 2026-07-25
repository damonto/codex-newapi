import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "../src/config.ts";
import { FAILURE_THRESHOLD, ServiceHealth } from "../src/health.ts";
import { resolveModelRoute, selectAvailableService } from "../src/routing.ts";

const config = parseConfig({
  services: [
    {
      id: "secondary",
      base_url: "https://secondary.example/v1",
      api_key: "two",
      priority: 10,
      models: ["grok-4.5", "review-model"],
    },
    {
      id: "primary",
      base_url: "https://primary.example/v1",
      api_key: "one",
      priority: 100,
      models: ["grok-4.5"],
    },
  ],
  api_keys: [{ api_key: "client", services: ["secondary", "primary"] }],
  model_aliases: { "gpt-5.6-sol": "grok-4.5" },
  codex_auto_review: { service: "secondary", model: "review-model" },
});
const client = config.api_keys[0];

test("normal aliases resolve globally and services remain priority ordered", () => {
  const route = resolveModelRoute(config, client, "gpt-5.6-sol");
  assert.equal(route.upstreamModel, "grok-4.5");
  assert.deepEqual(route.services.map((service) => service.id), ["primary", "secondary"]);
});

test("codex-auto-review is pinned to its configured service", () => {
  const route = resolveModelRoute(config, client, "codex-auto-review");
  assert.equal(route.upstreamModel, "review-model");
  assert.deepEqual(route.services.map((service) => service.id), ["secondary"]);
});

test("a cooling primary service is skipped for the next priority", async () => {
  const primary = new ServiceHealth({}, {});
  const secondary = new ServiceHealth({}, {});
  for (let index = 0; index < FAILURE_THRESHOLD; index += 1) {
    await primary.fetch(new Request("https://health/failure", { method: "POST" }));
  }
  const objects = new Map([
    ["primary", primary],
    ["secondary", secondary],
  ]);
  const env = {
    HEALTH: {
      idFromName: (name) => name,
      get: (id) => ({
        fetch: (input, init) =>
          objects.get(id).fetch(input instanceof Request ? input : new Request(input, init)),
      }),
    },
  };
  const route = resolveModelRoute(config, client, "gpt-5.6-sol");
  const selected = await selectAvailableService(env, route);
  assert.equal(selected.id, "secondary");
});

test("a model alias requires the real upstream model in the service list", () => {
  assert.throws(
    () =>
      parseConfig({
        services: [
          {
            id: "alias-only",
            base_url: "https://alias.example/v1",
            api_key: "alias-key",
            priority: 1,
            models: ["gpt-5.6-sol", "review-model"],
          },
        ],
        api_keys: [{ api_key: "alias-client", services: ["alias-only"] }],
        model_aliases: { "gpt-5.6-sol": "grok-4.5" },
        codex_auto_review: { service: "alias-only", model: "review-model" },
      }),
  );
});
