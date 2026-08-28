import assert from "node:assert/strict";
import test from "node:test";

import { resolveStoredAffinity } from "../src/affinity.ts";
import { parseConfig } from "../src/config.ts";
import { FAILURE_THRESHOLD, ServiceHealthState } from "../src/health.ts";
import {
  allowedServiceCandidates,
  resolveModelRoute,
  selectAvailableCatalogTargetsWithDetails,
  selectAvailableService,
  selectAvailableServiceWithDetails,
  selectServiceApiKey,
} from "../src/routing.ts";

const config = parseConfig({
  services: [
    {
      id: "secondary",
      base_url: "https://secondary.example/v1",
      keys: [
        {
          id: "secondary-key",
          api_key: "two",
          disabled: false,
          priority: 10,
        },
      ],
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
  api_keys: [
    { id: "client", api_key: "client", services: ["secondary", "primary"] },
  ],
  model_routes: {
    "gpt-5.6-sol": { model: "grok-4.5" },
    "codex-auto-review": { model: "review-model", services: ["secondary"] },
  },
});
const client = config.api_keys[0];

function routingEnvironment() {
  const healthObjects = new Map();
  const affinities = new Map();
  const healthObject = (name) => {
    if (!healthObjects.has(name)) {
      healthObjects.set(name, new ServiceHealthState());
    }
    return healthObjects.get(name);
  };
  return {
    affinities,
    healthObject,
    env: {
      HEALTH: { getByName: healthObject },
      SESSION_AFFINITY: {
        getByName: (name) => ({
          resolve: async (candidates, preferred) => {
            const stored = affinities.get(name);
            if (stored) {
              const decision = resolveStoredAffinity(
                stored,
                candidates,
                preferred,
                () => 0,
              );
              if (!decision.selection) {
                affinities.delete(name);
                return undefined;
              }
              const next = {
                ...stored,
                ...decision.selection,
                updated_at: Date.now(),
              };
              affinities.set(name, next);
              return { ...next, status: decision.status };
            }
            if (!preferred) {
              affinities.delete(name);
              return undefined;
            }
            const next = { ...preferred, updated_at: Date.now() };
            affinities.set(name, next);
            return { ...next, status: "created" };
          },
        }),
      },
    },
  };
}

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

test("equal service key priorities are selected from the full tie group", () => {
  const service = {
    ...config.services[1],
    keys: config.services[1].keys.map((key) => ({ ...key, priority: 50 })),
  };
  assert.equal(selectServiceApiKey(service).id, "primary-backup");
  assert.equal(selectServiceApiKey(service, () => 0).id, "primary-backup");
  assert.equal(selectServiceApiKey(service, () => 0.999999).id, "primary-key");
});

test("unconstrained routes resolve globally and services remain priority ordered", () => {
  const route = resolveModelRoute(config, client, "gpt-5.6-sol");
  assert.deepEqual(
    route.targets.map(({ service, keys, upstreamModel, routeApplied }) => [
      service.id,
      keys.map((key) => key.id),
      upstreamModel,
      routeApplied,
    ]),
    [
      ["primary", ["primary-backup", "primary-key"], "grok-4.5", true],
      ["secondary", ["secondary-key"], "grok-4.5", true],
    ],
  );
});

test("an unconfigured upstream model is not marked as a route", () => {
  const route = resolveModelRoute(config, client, "review-model");
  assert.deepEqual(
    route.targets.map(({ upstreamModel, routeApplied }) => [
      upstreamModel,
      routeApplied,
    ]),
    [
      ["review-model", false],
      ["review-model", false],
    ],
  );
});

test("route service constraints override global service priority", () => {
  const route = resolveModelRoute(config, client, "codex-auto-review");
  assert.deepEqual(
    route.targets.map(({ service, upstreamModel }) => [
      service.id,
      upstreamModel,
    ]),
    [["secondary", "review-model"]],
  );
});

test("route service constraints are intersected with client service access", () => {
  const route = resolveModelRoute(
    config,
    { id: "limited", api_key: "limited", services: ["primary"] },
    "codex-auto-review",
  );
  assert.deepEqual(route.targets, []);
});

test("required capabilities filter services before routing selection", () => {
  const capabilityConfig = parseConfig({
    services: [
      {
        id: "unsupported",
        base_url: "https://unsupported.example/v1",
        keys: [
          {
            id: "unsupported-key",
            api_key: "unsupported",
            disabled: false,
            priority: 10,
          },
        ],
        disabled: false,
        priority: 100,
        supports_websocket: false,
        supports_web_search: false,
        models: ["model"],
      },
      {
        id: "supported",
        base_url: "https://supported.example/v1",
        keys: [
          {
            id: "supported-key",
            api_key: "supported",
            disabled: false,
            priority: 10,
          },
        ],
        disabled: false,
        priority: 50,
        supports_websocket: true,
        supports_web_search: true,
        models: ["model"],
      },
    ],
    api_keys: [
      {
        id: "client",
        api_key: "client",
        services: ["unsupported", "supported"],
      },
    ],
    model_routes: {},
  });
  const capabilityClient = capabilityConfig.api_keys[0];

  assert.deepEqual(
    resolveModelRoute(capabilityConfig, capabilityClient, "model").targets.map(
      ({ service }) => service.id,
    ),
    ["unsupported", "supported"],
  );
  assert.deepEqual(
    resolveModelRoute(capabilityConfig, capabilityClient, "model", {
      requiredCapability: "supports_web_search",
    }).targets.map(({ service }) => service.id),
    ["supported"],
  );
  assert.deepEqual(
    resolveModelRoute(capabilityConfig, capabilityClient, "model", {
      requiredCapability: "supports_websocket",
    }).targets.map(({ service }) => service.id),
    ["supported"],
  );
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
  assert.deepEqual(
    route.targets.map(({ service, upstreamModel }) => [
      service.id,
      upstreamModel,
    ]),
    [["secondary", "grok-4.5"]],
  );
});

test("per-key routes override global routes for the same model", () => {
  const route = resolveModelRoute(
    {
      ...config,
      api_keys: [
        {
          id: "client",
          api_key: "client",
          services: ["primary", "secondary"],
          model_routes: {
            "gpt-5.6-sol": { model: "review-model", services: ["secondary"] },
          },
        },
      ],
    },
    {
      id: "client",
      api_key: "client",
      services: ["primary", "secondary"],
      model_routes: {
        "gpt-5.6-sol": { model: "review-model", services: ["secondary"] },
      },
    },
    "gpt-5.6-sol",
  );
  assert.deepEqual(
    route.targets.map(({ service, upstreamModel }) => [
      service.id,
      upstreamModel,
    ]),
    [["secondary", "review-model"]],
  );
});

test("per-key routes leave unconfigured models on the global routes", () => {
  const keyClient = {
    id: "client",
    api_key: "client",
    services: ["primary", "secondary"],
    model_routes: {
      "codex-auto-review": { model: "review-model", services: ["primary"] },
    },
  };
  const routed = resolveModelRoute(config, keyClient, "gpt-5.6-sol");
  assert.deepEqual(
    routed.targets.map(({ service, upstreamModel }) => [
      service.id,
      upstreamModel,
    ]),
    [
      ["primary", "grok-4.5"],
      ["secondary", "grok-4.5"],
    ],
  );
});

test("per-key routes apply only to the configured client", () => {
  const otherClient = {
    id: "other",
    api_key: "other",
    services: ["primary", "secondary"],
  };
  const routed = resolveModelRoute(config, otherClient, "gpt-5.6-sol");
  assert.deepEqual(
    routed.targets.map(({ service, upstreamModel }) => [
      service.id,
      upstreamModel,
    ]),
    [
      ["primary", "grok-4.5"],
      ["secondary", "grok-4.5"],
    ],
  );
});

test("per-key route services are intersected with client service access", () => {
  const keyClient = {
    id: "limited",
    api_key: "limited",
    services: ["primary"],
    model_routes: {
      "gpt-5.6-sol": { model: "review-model", services: ["secondary"] },
    },
  };
  const route = resolveModelRoute(config, keyClient, "gpt-5.6-sol");
  assert.deepEqual(route.targets, []);
});

test("service routes override per-key and global routes per service", () => {
  const serviceRoutes = {
    ...config,
    services: config.services.map((service) => ({
      ...service,
      model_routes:
        service.id === "primary"
          ? { "gpt-5.6-sol": { model: "review-model" } }
          : { "gpt-5.6-sol": { model: "grok-4.5" } },
    })),
  };
  const route = resolveModelRoute(serviceRoutes, client, "gpt-5.6-sol");
  assert.deepEqual(
    route.targets.map(({ service, upstreamModel }) => [
      service.id,
      upstreamModel,
    ]),
    [
      ["primary", "review-model"],
      ["secondary", "grok-4.5"],
    ],
  );
});

test("service routes override lower layers even when the lower route constrains services", () => {
  const serviceRoutes = {
    ...config,
    services: config.services.map((service) => ({
      ...service,
      model_routes:
        service.id === "primary"
          ? { "gpt-5.6-sol": { model: "review-model" } }
          : undefined,
    })),
  };
  const keyClient = {
    id: "client",
    api_key: "client",
    services: ["primary", "secondary"],
    model_routes: {
      "gpt-5.6-sol": { model: "grok-4.5", services: ["secondary"] },
    },
  };
  const route = resolveModelRoute(serviceRoutes, keyClient, "gpt-5.6-sol");
  assert.deepEqual(
    route.targets.map(({ service, upstreamModel }) => [
      service.id,
      upstreamModel,
    ]),
    [
      ["primary", "review-model"],
      ["secondary", "grok-4.5"],
    ],
  );
});

test("a service route can hide a model from that service only", () => {
  const route = resolveModelRoute(
    {
      ...config,
      services: config.services.map((service) => ({
        ...service,
        model_routes:
          service.id === "primary"
            ? { "grok-4.5": { model: "review-model" } }
            : undefined,
      })),
    },
    client,
    "grok-4.5",
  );
  assert.deepEqual(
    route.targets.map(({ service, upstreamModel }) => [
      service.id,
      upstreamModel,
    ]),
    [
      ["primary", "review-model"],
      ["secondary", "grok-4.5"],
    ],
  );
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
  assert.deepEqual(
    route.targets.map(({ service }) => service.id),
    ["secondary"],
  );

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
  assert.equal(healthChecks, 2);
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
      keys:
        service.id === "primary"
          ? service.keys.map((key) => ({ ...key, disabled: true }))
          : service.keys,
    })),
  };
  const route = resolveModelRoute(noPrimaryKeys, client, "gpt-5.6-sol");
  assert.deepEqual(
    route.targets.map(({ service }) => service.id),
    ["secondary"],
  );
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
    ["key:primary:primary-backup", new ServiceHealthState()],
    ["key:primary:primary-key", new ServiceHealthState()],
    ["key:secondary:secondary-key", new ServiceHealthState()],
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

test("service-first and key-second random selection use independent tie boundaries", async () => {
  const equalConfig = parseConfig({
    services: [
      {
        id: "first",
        base_url: "https://first.example/v1",
        keys: [
          { id: "first-a", api_key: "a", disabled: false, priority: 10 },
          { id: "first-b", api_key: "b", disabled: false, priority: 10 },
        ],
        disabled: false,
        priority: 50,
        models: ["model"],
      },
      {
        id: "second",
        base_url: "https://second.example/v1",
        keys: [
          { id: "second-a", api_key: "c", disabled: false, priority: 10 },
          { id: "second-b", api_key: "d", disabled: false, priority: 10 },
        ],
        disabled: false,
        priority: 50,
        models: ["model"],
      },
    ],
    api_keys: [
      { id: "client", api_key: "client", services: ["first", "second"] },
    ],
    model_routes: {},
  });
  const route = resolveModelRoute(
    equalConfig,
    equalConfig.api_keys[0],
    "model",
  );
  const { env } = routingEnvironment();

  const defaultSelection = await selectAvailableServiceWithDetails(env, route);
  assert.equal(defaultSelection.target.service.id, "first");
  assert.equal(defaultSelection.target.key.id, "first-a");

  const values = [0.999999, 0];
  const selection = await selectAvailableServiceWithDetails(env, route, {
    random: () => values.shift(),
  });
  assert.equal(selection.target.service.id, "second");
  assert.equal(selection.target.key.id, "second-a");

  const opposite = [0, 0.999999];
  const secondSelection = await selectAvailableServiceWithDetails(env, route, {
    random: () => opposite.shift(),
  });
  assert.equal(secondSelection.target.service.id, "first");
  assert.equal(secondSelection.target.key.id, "first-b");
});

test("a cooling key is skipped without cooling its service", async () => {
  const { env, healthObject } = routingEnvironment();
  healthObject("key:primary:primary-key").recordImmediateFailure();
  const route = resolveModelRoute(config, client, "gpt-5.6-sol");
  const selection = await selectAvailableServiceWithDetails(env, route, {
    random: () => 0,
  });

  assert.equal(selection.target.service.id, "primary");
  assert.equal(selection.target.key.id, "primary-backup");
  assert.equal(
    selection.keyChecks.find((check) => check.key_id === "primary-key")
      .available,
    false,
  );
});

test("a service with no available keys falls back to the next service priority", async () => {
  const { env, healthObject } = routingEnvironment();
  healthObject("key:primary:primary-key").recordImmediateFailure();
  healthObject("key:primary:primary-backup").recordImmediateFailure();
  const route = resolveModelRoute(config, client, "gpt-5.6-sol");
  const selection = await selectAvailableServiceWithDetails(env, route, {
    random: () => 0,
  });

  assert.equal(selection.target.service.id, "secondary");
  assert.equal(selection.target.key.id, "secondary-key");
});

test("catalog selection uses catalog health and randomizes only tied keys per service", async () => {
  const catalogConfig = parseConfig({
    services: [
      {
        id: "catalog",
        base_url: "https://catalog.example/v1",
        keys: [
          { id: "catalog-a", api_key: "a", disabled: false, priority: 10 },
          { id: "catalog-b", api_key: "b", disabled: false, priority: 10 },
        ],
        disabled: false,
        priority: 10,
        models: ["model"],
      },
    ],
    api_keys: [{ id: "client", api_key: "client", services: ["catalog"] }],
    model_routes: {},
  });
  const { env, healthObject } = routingEnvironment();
  healthObject("key:catalog:catalog-b").recordImmediateFailure();
  const candidates = allowedServiceCandidates(
    catalogConfig,
    catalogConfig.api_keys[0],
  );

  const first = await selectAvailableCatalogTargetsWithDetails(
    env,
    candidates,
    () => 0.999999,
  );
  assert.equal(first.targets[0].key.id, "catalog-b");

  healthObject("key:catalog:catalog-b:catalog").recordImmediateFailure();
  const second = await selectAvailableCatalogTargetsWithDetails(
    env,
    candidates,
    () => 0.999999,
  );
  assert.equal(second.targets[0].key.id, "catalog-a");
});

test("session affinity is stable, client-isolated, and rebinds after key cooldown", async () => {
  const equalConfig = parseConfig({
    services: [
      {
        id: "first",
        base_url: "https://first.example/v1",
        keys: [
          { id: "first-a", api_key: "a", disabled: false, priority: 10 },
          { id: "first-b", api_key: "b", disabled: false, priority: 10 },
        ],
        disabled: false,
        priority: 50,
        models: ["model"],
      },
      {
        id: "second",
        base_url: "https://second.example/v1",
        keys: [
          { id: "second-a", api_key: "c", disabled: false, priority: 10 },
          { id: "second-b", api_key: "d", disabled: false, priority: 10 },
        ],
        disabled: false,
        priority: 50,
        models: ["model"],
      },
    ],
    api_keys: [
      { id: "client-a", api_key: "client-a", services: ["first", "second"] },
    ],
    model_routes: {},
  });
  const route = resolveModelRoute(
    equalConfig,
    equalConfig.api_keys[0],
    "model",
  );
  const { env, healthObject } = routingEnvironment();
  const firstRandom = [0.999999, 0.999999];
  const first = await selectAvailableServiceWithDetails(env, route, {
    random: () => firstRandom.shift(),
    session: { clientApiKey: "client-a", sessionId: "session" },
  });
  assert.deepEqual(
    [first.target.service.id, first.target.key.id, first.affinity.status],
    ["second", "second-b", "created"],
  );

  const repeated = await selectAvailableServiceWithDetails(env, route, {
    random: () => 0,
    session: { clientApiKey: "client-a", sessionId: "session" },
  });
  assert.deepEqual(
    [
      repeated.target.service.id,
      repeated.target.key.id,
      repeated.affinity.status,
    ],
    ["second", "second-b", "hit"],
  );

  const otherClient = await selectAvailableServiceWithDetails(env, route, {
    random: () => 0,
    session: { clientApiKey: "client-b", sessionId: "session" },
  });
  assert.deepEqual(
    [otherClient.target.service.id, otherClient.target.key.id],
    ["first", "first-a"],
  );

  healthObject("key:second:second-b").recordImmediateFailure();
  const rebound = await selectAvailableServiceWithDetails(env, route, {
    random: () => 0,
    session: { clientApiKey: "client-a", sessionId: "session" },
  });
  assert.deepEqual(
    [rebound.target.service.id, rebound.target.key.id, rebound.affinity.status],
    ["first", "first-a", "rebound"],
  );
});

test("session affinity upgrades when a higher-priority service recovers", async () => {
  const { env, healthObject } = routingEnvironment();
  for (let index = 0; index < FAILURE_THRESHOLD; index += 1) {
    healthObject("primary").recordFailure();
  }
  const route = resolveModelRoute(config, client, "gpt-5.6-sol");
  const session = { clientApiKey: "client", sessionId: "service-upgrade" };
  const initial = await selectAvailableServiceWithDetails(env, route, {
    random: () => 0,
    session,
  });
  assert.deepEqual(
    [initial.target.service.id, initial.affinity.status],
    ["secondary", "created"],
  );

  healthObject("primary").clear();
  const upgraded = await selectAvailableServiceWithDetails(env, route, {
    random: () => 0,
    session,
  });
  assert.deepEqual(
    [
      upgraded.target.service.id,
      upgraded.target.key.id,
      upgraded.affinity.status,
    ],
    ["primary", "primary-key", "rebound"],
  );
});

test("session affinity upgrades a key only inside its current top-priority service", async () => {
  const { env, healthObject } = routingEnvironment();
  healthObject("key:primary:primary-key").recordImmediateFailure();
  const route = resolveModelRoute(config, client, "gpt-5.6-sol");
  const session = { clientApiKey: "client", sessionId: "key-upgrade" };
  const initial = await selectAvailableServiceWithDetails(env, route, {
    random: () => 0,
    session,
  });
  assert.deepEqual(
    [initial.target.service.id, initial.target.key.id, initial.affinity.status],
    ["primary", "primary-backup", "created"],
  );

  healthObject("key:primary:primary-key").clear();
  const upgraded = await selectAvailableServiceWithDetails(env, route, {
    random: () => 0,
    session,
  });
  assert.deepEqual(
    [
      upgraded.target.service.id,
      upgraded.target.key.id,
      upgraded.affinity.status,
    ],
    ["primary", "primary-key", "rebound"],
  );
});

test("equal service and key priorities do not churn an existing affinity", async () => {
  const equalConfig = parseConfig({
    services: [
      {
        id: "first",
        base_url: "https://first.example/v1",
        keys: [
          { id: "first-key", api_key: "first", disabled: false, priority: 10 },
        ],
        disabled: false,
        priority: 50,
        models: ["model"],
      },
      {
        id: "second",
        base_url: "https://second.example/v1",
        keys: [
          {
            id: "second-key",
            api_key: "second",
            disabled: false,
            priority: 10,
          },
        ],
        disabled: false,
        priority: 50,
        models: ["model"],
      },
    ],
    api_keys: [
      { id: "client", api_key: "client", services: ["first", "second"] },
    ],
    model_routes: {},
  });
  const { env } = routingEnvironment();
  const route = resolveModelRoute(
    equalConfig,
    equalConfig.api_keys[0],
    "model",
  );
  const session = { clientApiKey: "client", sessionId: "equal-priority" };
  const initial = await selectAvailableServiceWithDetails(env, route, {
    random: () => 0.999999,
    session,
  });
  assert.equal(initial.target.service.id, "second");

  const repeated = await selectAvailableServiceWithDetails(env, route, {
    random: () => 0,
    session,
  });
  assert.deepEqual(
    [repeated.target.service.id, repeated.affinity.status],
    ["second", "hit"],
  );
});

test("session affinity rebinds after a required service capability is removed", async () => {
  const capabilityConfig = parseConfig({
    services: [
      {
        id: "first",
        base_url: "https://first.example/v1",
        keys: [
          { id: "first-key", api_key: "first", disabled: false, priority: 10 },
        ],
        disabled: false,
        priority: 50,
        supports_websocket: false,
        supports_web_search: true,
        models: ["model"],
      },
      {
        id: "second",
        base_url: "https://second.example/v1",
        keys: [
          {
            id: "second-key",
            api_key: "second",
            disabled: false,
            priority: 10,
          },
        ],
        disabled: false,
        priority: 50,
        supports_websocket: false,
        supports_web_search: true,
        models: ["model"],
      },
    ],
    api_keys: [
      { id: "client", api_key: "client", services: ["first", "second"] },
    ],
    model_routes: {},
  });
  const { env } = routingEnvironment();
  const session = { clientApiKey: "client", sessionId: "capability-change" };
  const initial = await selectAvailableServiceWithDetails(
    env,
    resolveModelRoute(capabilityConfig, capabilityConfig.api_keys[0], "model", {
      requiredCapability: "supports_web_search",
    }),
    { random: () => 0, session },
  );
  assert.deepEqual(
    [initial.target.service.id, initial.affinity.status],
    ["first", "created"],
  );

  const updatedConfig = {
    ...capabilityConfig,
    services: capabilityConfig.services.map((service) =>
      service.id === "first"
        ? { ...service, supports_web_search: false }
        : service,
    ),
  };
  const rebound = await selectAvailableServiceWithDetails(
    env,
    resolveModelRoute(updatedConfig, capabilityConfig.api_keys[0], "model", {
      requiredCapability: "supports_web_search",
    }),
    { random: () => 0, session },
  );
  assert.deepEqual(
    [rebound.target.service.id, rebound.affinity.status],
    ["second", "rebound"],
  );
});

test("session affinity rebinds for every configuration, permission, model, and service invalidation", async () => {
  const { env, healthObject } = routingEnvironment();
  const initialRoute = resolveModelRoute(config, client, "gpt-5.6-sol");
  const initial = await selectAvailableServiceWithDetails(env, initialRoute, {
    random: () => 0,
    session: { clientApiKey: "client", sessionId: "reconfigure" },
  });
  assert.equal(initial.target.service.id, "primary");

  const disabledConfig = {
    ...config,
    services: config.services.map((service) =>
      service.id === "primary" ? { ...service, disabled: true } : service,
    ),
  };
  const rebound = await selectAvailableServiceWithDetails(
    env,
    resolveModelRoute(disabledConfig, client, "gpt-5.6-sol"),
    {
      random: () => 0,
      session: { clientApiKey: "client", sessionId: "reconfigure" },
    },
  );
  assert.deepEqual(
    [rebound.target.service.id, rebound.affinity.status],
    ["secondary", "rebound"],
  );

  const permissionRoute = resolveModelRoute(
    config,
    { id: "client", api_key: "client", services: ["primary"] },
    "gpt-5.6-sol",
  );
  const permissionSelection = await selectAvailableServiceWithDetails(
    env,
    permissionRoute,
    {
      random: () => 0,
      session: { clientApiKey: "client", sessionId: "reconfigure" },
    },
  );
  assert.deepEqual(
    [
      permissionSelection.target.service.id,
      permissionSelection.affinity.status,
    ],
    ["primary", "rebound"],
  );

  const removedConfig = {
    ...config,
    services: config.services.filter((service) => service.id !== "primary"),
  };
  const removedSelection = await selectAvailableServiceWithDetails(
    env,
    resolveModelRoute(removedConfig, client, "gpt-5.6-sol"),
    {
      random: () => 0,
      session: { clientApiKey: "client", sessionId: "reconfigure" },
    },
  );
  assert.deepEqual(
    [removedSelection.target.service.id, removedSelection.affinity.status],
    ["secondary", "rebound"],
  );

  const unsupportedConfig = {
    ...config,
    services: config.services.map((service) =>
      service.id === "secondary"
        ? { ...service, models: ["other-model"] }
        : service,
    ),
  };
  const unsupportedSelection = await selectAvailableServiceWithDetails(
    env,
    resolveModelRoute(unsupportedConfig, client, "gpt-5.6-sol"),
    {
      random: () => 0,
      session: { clientApiKey: "client", sessionId: "reconfigure" },
    },
  );
  assert.deepEqual(
    [
      unsupportedSelection.target.service.id,
      unsupportedSelection.affinity.status,
    ],
    ["primary", "rebound"],
  );

  const disabledKeyConfig = {
    ...config,
    services: config.services.map((service) =>
      service.id === "primary"
        ? {
            ...service,
            keys: service.keys.map((key) =>
              key.id === "primary-key" ? { ...key, disabled: true } : key,
            ),
          }
        : service,
    ),
  };
  const disabledKeySelection = await selectAvailableServiceWithDetails(
    env,
    resolveModelRoute(disabledKeyConfig, client, "gpt-5.6-sol"),
    {
      random: () => 0,
      session: { clientApiKey: "client", sessionId: "reconfigure" },
    },
  );
  assert.deepEqual(
    [
      disabledKeySelection.target.service.id,
      disabledKeySelection.target.key.id,
      disabledKeySelection.affinity.status,
    ],
    ["primary", "primary-backup", "rebound"],
  );

  for (let index = 0; index < FAILURE_THRESHOLD; index += 1) {
    healthObject("primary").recordFailure();
  }
  const coolingSelection = await selectAvailableServiceWithDetails(
    env,
    resolveModelRoute(config, client, "gpt-5.6-sol"),
    {
      random: () => 0,
      session: { clientApiKey: "client", sessionId: "reconfigure" },
    },
  );
  assert.deepEqual(
    [coolingSelection.target.service.id, coolingSelection.affinity.status],
    ["secondary", "rebound"],
  );
});

test("affinity read failures fail open to deterministic random selection", async () => {
  const route = resolveModelRoute(config, client, "gpt-5.6-sol");
  const { env } = routingEnvironment();
  env.SESSION_AFFINITY.getByName = () => {
    throw new Error("affinity unavailable");
  };
  const selection = await selectAvailableServiceWithDetails(env, route, {
    random: () => 0,
    session: { clientApiKey: "client", sessionId: "session" },
  });

  assert.equal(selection.target.service.id, "primary");
  assert.equal(selection.target.key.id, "primary-key");
  assert.equal(selection.affinity.status, "failed");
});

test("a model route requires the real upstream model in the service list", () => {
  assert.throws(() =>
    parseConfig({
      services: [
        {
          id: "alias-only",
          base_url: "https://alias.example/v1",
          keys: [
            {
              id: "alias-key",
              api_key: "alias-key",
              disabled: false,
              priority: 1,
            },
          ],
          disabled: false,
          priority: 1,
          models: ["gpt-5.6-sol", "review-model"],
        },
      ],
      api_keys: [
        {
          id: "alias-client",
          api_key: "alias-client",
          services: ["alias-only"],
        },
      ],
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
