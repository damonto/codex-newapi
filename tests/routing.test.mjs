import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "../src/config.ts";
import { FAILURE_THRESHOLD, ServiceHealthState } from "../src/health.ts";
import {
  resolveModelRoute,
  selectAvailableService,
  selectServiceApiKey,
} from "../src/routing.ts";

const config = parseConfig({
  services: [
    {
      id: "secondary",
      base_url: "https://secondary.example/v1",
      keys: [{
        id: "secondary-key",
        api_key: "two",
        disabled: false,
        priority: 10,
      }],
      disabled: false,
      priority: 10,
      models: ["grok-4.5", "review-model"],
    },
    {
      id: "primary",
      base_url: "https://primary.example/v1",
      keys: [
        {
          id: "primary-backup",
          api_key: "one-backup",
          disabled: false,
          priority: 10,
        },
        {
          id: "primary-key",
          api_key: "one",
          disabled: false,
          priority: 100,
        },
      ],
      disabled: false,
      priority: 100,
      models: ["grok-4.5", "review-model"],
    },
  ],
  api_keys: [{ api_key: "client", services: ["secondary", "primary"] }],
  model_routes: {
    "gpt-5.6-sol": { model: "grok-4.5" },
    "codex-auto-review": { model: "review-model", services: ["secondary"] },
  },
});
const client = config.api_keys[0];

test("service keys are selected by priority", () => {
  assert.equal(selectServiceApiKey(config.services[1]).id, "primary-key");
});

test("disabled service keys are skipped", () => {
  const service = {
    ...config.services[1],
    keys: config.services[1].keys.map((key) => ({
      ...key,
      disabled: key.id === "primary-key",
    })),
  };
  assert.equal(selectServiceApiKey(service).id, "primary-backup");
});

test("equal service key priorities preserve configuration order", () => {
  const service = {
    ...config.services[1],
    keys: config.services[1].keys.map((key) => ({ ...key, priority: 50 })),
  };
  assert.equal(selectServiceApiKey(service).id, "primary-backup");
});

test("unconstrained routes resolve globally and services remain priority ordered", () => {
  const route = resolveModelRoute(config, client, "gpt-5.6-sol");
  assert.equal(route.upstreamModel, "grok-4.5");
  assert.equal(route.routeApplied, true);
  assert.deepEqual(
    route.targets.map(({ service, key }) => [service.id, key.id]),
    [["primary", "primary-key"], ["secondary", "secondary-key"]],
  );
});

test("an unconfigured upstream model is not marked as a route", () => {
  const route = resolveModelRoute(config, client, "review-model");
  assert.equal(route.upstreamModel, "review-model");
  assert.equal(route.routeApplied, false);
});

test("route service constraints override global service priority", () => {
  const route = resolveModelRoute(config, client, "codex-auto-review");
  assert.equal(route.upstreamModel, "review-model");
  assert.deepEqual(route.targets.map(({ service }) => service.id), ["secondary"]);
});

test("route service constraints are intersected with client service access", () => {
  const route = resolveModelRoute(
    config,
    { api_key: "limited", services: ["primary"] },
    "codex-auto-review",
  );
  assert.deepEqual(route.targets, []);
});

test("a route can constrain a real upstream model name", () => {
  const route = resolveModelRoute(
    {
      ...config,
      model_routes: {
        ...config.model_routes,
        "grok-4.5": { model: "grok-4.5", services: ["secondary"] },
      },
    },
    client,
    "grok-4.5",
  );
  assert.equal(route.upstreamModel, "grok-4.5");
  assert.equal(route.routeApplied, true);
  assert.deepEqual(route.targets.map(({ service }) => service.id), ["secondary"]);
});

test("disabled services are excluded before priority and health selection", async () => {
  const disabledConfig = {
    ...config,
    services: config.services.map((service) => ({
      ...service,
      disabled: service.id === "primary",
    })),
  };
  const route = resolveModelRoute(disabledConfig, client, "gpt-5.6-sol");
  assert.deepEqual(route.targets.map(({ service }) => service.id), ["secondary"]);

  let healthChecks = 0;
  const selected = await selectAvailableService(
    {
      HEALTH: {
        getByName: () => ({
          getStatus: async () => {
            healthChecks += 1;
            return { failures: 0, cooling_until: null };
          },
        }),
      },
    },
    route,
  );
  assert.equal(selected.id, "secondary");
  assert.equal(healthChecks, 1);
});

test("a disabled route-constrained service is unavailable", () => {
  const disabledConfig = {
    ...config,
    services: config.services.map((service) => ({
      ...service,
      disabled: service.id === "secondary",
    })),
  };
  const route = resolveModelRoute(disabledConfig, client, "codex-auto-review");
  assert.deepEqual(route.targets, []);
});

test("a service without enabled keys is excluded from routing", () => {
  const noPrimaryKeys = {
    ...config,
    services: config.services.map((service) => ({
      ...service,
      keys: service.id === "primary"
        ? service.keys.map((key) => ({ ...key, disabled: true }))
        : service.keys,
    })),
  };
  const route = resolveModelRoute(noPrimaryKeys, client, "gpt-5.6-sol");
  assert.deepEqual(route.targets.map(({ service }) => service.id), ["secondary"]);
});

test("a cooling primary service is skipped for the next priority", async () => {
  const primary = new ServiceHealthState();
  const secondary = new ServiceHealthState();
  for (let index = 0; index < FAILURE_THRESHOLD; index += 1) {
    primary.recordFailure();
  }
  const objects = new Map([
    ["primary", primary],
    ["secondary", secondary],
  ]);
  const env = {
    HEALTH: {
      getByName: (name) => objects.get(name),
    },
  };
  const route = resolveModelRoute(config, client, "gpt-5.6-sol");
  const selected = await selectAvailableService(env, route);
  assert.equal(selected.id, "secondary");
});

test("a model route requires the real upstream model in the service list", () => {
  assert.throws(
    () =>
      parseConfig({
        services: [
          {
            id: "alias-only",
            base_url: "https://alias.example/v1",
            keys: [{
              id: "alias-key",
              api_key: "alias-key",
              disabled: false,
              priority: 1,
            }],
            disabled: false,
            priority: 1,
            models: ["gpt-5.6-sol", "review-model"],
          },
        ],
        api_keys: [{ api_key: "alias-client", services: ["alias-only"] }],
        model_routes: {
          "gpt-5.6-sol": { model: "grok-4.5" },
          "codex-auto-review": {
            model: "review-model",
            services: ["alias-only"],
          },
        },
      }),
  );
});
