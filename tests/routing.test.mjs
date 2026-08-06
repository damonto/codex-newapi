import assert from "node:assert/strict";
import test from "node:test";

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
            const isCandidate = (selection) => selection !== undefined &&
              candidates.some((service) =>
                service.service_id === selection.service_id &&
                service.keys.some((key) => key.key_id === selection.key_id)
              );
            if (isCandidate(stored)) {
              return { ...stored, updated_at: Date.now(), status: "hit" };
            }
            if (!isCandidate(preferred)) {
              affinities.delete(name);
              return undefined;
            }
            const status = stored === undefined ? "created" : "rebound";
            const next = { ...preferred, updated_at: Date.now() };
            affinities.set(name, next);
            return { ...next, status };
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
  assert.equal(selectServiceApiKey(service, () => 0).id, "primary-backup");
  assert.equal(selectServiceApiKey(service, () => 0.999999).id, "primary-key");
});

test("unconstrained routes resolve globally and services remain priority ordered", () => {
  const route = resolveModelRoute(config, client, "gpt-5.6-sol");
  assert.equal(route.upstreamModel, "grok-4.5");
  assert.equal(route.routeApplied, true);
  assert.deepEqual(
    route.targets.map(({ service, keys }) => [
      service.id,
      keys.map((key) => key.id),
    ]),
    [
      ["primary", ["primary-backup", "primary-key"]],
      ["secondary", ["secondary-key"]],
    ],
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

test("required capabilities filter services before routing selection", () => {
  const capabilityConfig = parseConfig({
    services: [
      {
        id: "unsupported",
        base_url: "https://unsupported.example/v1",
        keys: [{
          id: "unsupported-key",
          api_key: "unsupported",
          disabled: false,
          priority: 10,
        }],
        disabled: false,
        priority: 100,
        supports_websocket: false,
        supports_web_search: false,
        models: ["model"],
      },
      {
        id: "supported",
        base_url: "https://supported.example/v1",
        keys: [{
          id: "supported-key",
          api_key: "supported",
          disabled: false,
          priority: 10,
        }],
        disabled: false,
        priority: 50,
        supports_websocket: true,
        supports_web_search: true,
        models: ["model"],
      },
    ],
    api_keys: [{ api_key: "client", services: ["unsupported", "supported"] }],
    model_routes: {},
  });
  const capabilityClient = capabilityConfig.api_keys[0];

  assert.deepEqual(
    resolveModelRoute(capabilityConfig, capabilityClient, "model")
      .targets.map(({ service }) => service.id),
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
    api_keys: [{ api_key: "client", services: ["first", "second"] }],
    model_routes: {},
  });
  const route = resolveModelRoute(equalConfig, equalConfig.api_keys[0], "model");
  const { env } = routingEnvironment();

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
    selection.keyChecks.find((check) => check.key_id === "primary-key").available,
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
    services: [{
      id: "catalog",
      base_url: "https://catalog.example/v1",
      keys: [
        { id: "catalog-a", api_key: "a", disabled: false, priority: 10 },
        { id: "catalog-b", api_key: "b", disabled: false, priority: 10 },
      ],
      disabled: false,
      priority: 10,
      models: ["model"],
    }],
    api_keys: [{ api_key: "client", services: ["catalog"] }],
    model_routes: {},
  });
  const { env, healthObject } = routingEnvironment();
  healthObject("key:catalog:catalog-b").recordImmediateFailure();
  const candidates = allowedServiceCandidates(catalogConfig, catalogConfig.api_keys[0]);

  const first = await selectAvailableCatalogTargetsWithDetails(env, candidates, () => 0.999999);
  assert.equal(first.targets[0].key.id, "catalog-b");

  healthObject("key:catalog:catalog-b:catalog").recordImmediateFailure();
  const second = await selectAvailableCatalogTargetsWithDetails(env, candidates, () => 0.999999);
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
    api_keys: [{ api_key: "client-a", services: ["first", "second"] }],
    model_routes: {},
  });
  const route = resolveModelRoute(equalConfig, equalConfig.api_keys[0], "model");
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
    [repeated.target.service.id, repeated.target.key.id, repeated.affinity.status],
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

test("session affinity rebinds after a required service capability is removed", async () => {
  const capabilityConfig = parseConfig({
    services: [
      {
        id: "first",
        base_url: "https://first.example/v1",
        keys: [{ id: "first-key", api_key: "first", disabled: false, priority: 10 }],
        disabled: false,
        priority: 50,
        supports_websocket: false,
        supports_web_search: true,
        models: ["model"],
      },
      {
        id: "second",
        base_url: "https://second.example/v1",
        keys: [{ id: "second-key", api_key: "second", disabled: false, priority: 10 }],
        disabled: false,
        priority: 50,
        supports_websocket: false,
        supports_web_search: true,
        models: ["model"],
      },
    ],
    api_keys: [{ api_key: "client", services: ["first", "second"] }],
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
        : service
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
    services: config.services.map((service) => service.id === "primary"
      ? { ...service, disabled: true }
      : service),
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
    { api_key: "client", services: ["primary"] },
    "gpt-5.6-sol",
  );
  const permissionSelection = await selectAvailableServiceWithDetails(env, permissionRoute, {
    random: () => 0,
    session: { clientApiKey: "client", sessionId: "reconfigure" },
  });
  assert.deepEqual(
    [permissionSelection.target.service.id, permissionSelection.affinity.status],
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
    services: config.services.map((service) => service.id === "secondary"
      ? { ...service, models: ["other-model"] }
      : service),
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
    [unsupportedSelection.target.service.id, unsupportedSelection.affinity.status],
    ["primary", "rebound"],
  );

  const disabledKeyConfig = {
    ...config,
    services: config.services.map((service) => service.id === "primary"
      ? {
        ...service,
        keys: service.keys.map((key) => key.id === "primary-key"
          ? { ...key, disabled: true }
          : key),
      }
      : service),
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
