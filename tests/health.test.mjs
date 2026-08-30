import assert from "node:assert/strict";
import test from "node:test";

import { SERVICE_FAN_OUT_CONCURRENCY } from "../src/concurrency.ts";
import {
  COOLDOWN_MS,
  FAILURE_THRESHOLD,
  FAILURE_WINDOW_MS,
  clearKeyHealth,
  clearServiceHealth,
  healthFailureScope,
  keyIsAvailable,
  listCoolingHealth,
  listCoolingServices,
  recordKeyFailure,
  recordServiceFailure,
  scheduleHealthUpdate,
  serviceIsAvailable,
  ServiceHealthState,
} from "../src/health.ts";

test("ten consecutive failures start a cooldown and success resets state", async () => {
  const health = new ServiceHealthState();
  for (let index = 0; index < FAILURE_THRESHOLD; index += 1) {
    health.recordFailure();
  }

  let snapshot = health.getStatus();
  assert.equal(snapshot.failures, FAILURE_THRESHOLD);
  assert.equal(typeof snapshot.cooling_until, "number");

  snapshot = health.recordSuccess();
  assert.deepEqual(snapshot, { failures: 0, cooling_until: null });
});

test("failures outside the five-minute window do not join the same streak", async () => {
  let now = 1_000;
  const health = new ServiceHealthState(() => now);

  for (let index = 0; index < FAILURE_THRESHOLD - 1; index += 1) {
    health.recordFailure();
  }

  now += FAILURE_WINDOW_MS;
  health.recordFailure();

  const snapshot = health.getStatus();
  assert.deepEqual(snapshot, { failures: 1, cooling_until: null });
});

test("an expired failure window is cleared when health is read", async () => {
  let now = 3_000;
  const health = new ServiceHealthState(() => now);
  health.recordFailure();

  now += FAILURE_WINDOW_MS;
  const snapshot = health.getStatus();
  assert.deepEqual(snapshot, { failures: 0, cooling_until: null });
});

test("ten failures inside one five-minute window start a cooldown", async () => {
  let now = 2_000;
  const health = new ServiceHealthState(() => now);

  for (let index = 0; index < FAILURE_THRESHOLD; index += 1) {
    now += 20_000;
    health.recordFailure();
  }

  const snapshot = health.getStatus();
  assert.equal(snapshot.failures, FAILURE_THRESHOLD);
  assert.equal(typeof snapshot.cooling_until, "number");
});

test("OpenAI statuses resolve to one failure scope each", () => {
  const scope = (status) => healthFailureScope(status, "openai");
  assert.equal(scope(400), "service");
  assert.equal(scope(503), "service");
  assert.equal(scope(402), "key");
  assert.equal(scope(403), "key");
  assert.equal(scope(401), undefined);
  assert.equal(scope(429), undefined);
  assert.equal(scope(500), undefined);
});

test("Anthropic statuses resolve to one failure scope each", () => {
  const scope = (status) => healthFailureScope(status, "anthropic");
  assert.equal(scope(500), "service");
  assert.equal(scope(502), "service");
  assert.equal(scope(503), "service");
  assert.equal(scope(529), "service");
  assert.equal(scope(401), "key");
  assert.equal(scope(403), "key");
  assert.equal(scope(402), undefined);
  assert.equal(scope(400), undefined);
  assert.equal(scope(429), undefined);
});

test("statuses outside the failure maps are not counted", () => {
  for (const protocol of ["openai", "anthropic"]) {
    for (const status of [200, 201, 301, 404, 408, 418, 501]) {
      assert.equal(
        healthFailureScope(status, protocol),
        undefined,
        `status ${status} on ${protocol} should not affect health`,
      );
    }
  }
});

test("a first key failure starts a 30-minute cooldown that expires normally", () => {
  let now = 10_000;
  const health = new ServiceHealthState(() => now);
  const snapshot = health.recordImmediateFailure();
  assert.deepEqual(snapshot, {
    failures: 1,
    cooling_until: now + COOLDOWN_MS,
  });

  now += COOLDOWN_MS;
  assert.deepEqual(health.getStatus(), { failures: 0, cooling_until: null });
});

test("a repeated key failure refreshes the full 30-minute cooldown", () => {
  let now = 20_000;
  const health = new ServiceHealthState(() => now);
  health.recordImmediateFailure();

  now += 10 * 60 * 1000;
  const refreshed = health.recordImmediateFailure();
  assert.deepEqual(refreshed, {
    failures: 1,
    cooling_until: now + COOLDOWN_MS,
  });
});

test("catalog health is isolated from inference health", async () => {
  const objects = new Map([
    ["service", new ServiceHealthState()],
    ["service:catalog", new ServiceHealthState()],
  ]);
  const env = {
    HEALTH: {
      getByName: (name) => objects.get(name),
    },
  };
  for (let index = 0; index < FAILURE_THRESHOLD; index += 1) {
    await recordServiceFailure(env, "service", "test", "catalog");
  }
  assert.equal(await serviceIsAvailable(env, "service", "inference"), true);
  assert.equal(await serviceIsAvailable(env, "service", "catalog"), false);

  await clearServiceHealth(env, "service", "catalog");
  assert.equal(await serviceIsAvailable(env, "service", "catalog"), true);
  assert.equal(await serviceIsAvailable(env, "service", "inference"), true);
});

test("catalog key cooldown is isolated from inference key cooldown", async () => {
  const objects = new Map([
    ["key:service:key", new ServiceHealthState()],
    ["key:service:key:catalog", new ServiceHealthState()],
  ]);
  const env = {
    HEALTH: {
      getByName: (name) => objects.get(name),
    },
  };

  await recordKeyFailure(env, "service", "key", "test", "catalog");
  assert.equal(await keyIsAvailable(env, "service", "key", "inference"), true);
  assert.equal(await keyIsAvailable(env, "service", "key", "catalog"), false);

  await clearKeyHealth(env, "service", "key", "catalog");
  assert.equal(await keyIsAvailable(env, "service", "key", "catalog"), true);
  assert.equal(await keyIsAvailable(env, "service", "key", "inference"), true);
});

test("health listing preserves service and key configuration order", async () => {
  const services = [
    {
      id: "first",
      keys: [{ id: "first-a" }, { id: "first-b" }],
    },
    {
      id: "second",
      keys: [{ id: "second-a" }],
    },
  ];
  const objects = new Map();
  const get = (name) => {
    if (!objects.has(name)) {
      objects.set(name, new ServiceHealthState());
    }
    return objects.get(name);
  };
  const env = { HEALTH: { getByName: get } };
  for (let index = 0; index < FAILURE_THRESHOLD; index += 1) {
    get("first").recordFailure();
  }
  get("key:first:first-b").recordImmediateFailure();
  get("key:second:second-a").recordImmediateFailure();

  const cooling = await listCoolingHealth(env, services);
  assert.deepEqual(
    cooling.map((entry) => [entry.service_id, entry.key_id ?? null]),
    [
      ["first", null],
      ["first", "first-b"],
      ["second", "second-a"],
    ],
  );
});

test("stored state recreates an active cooldown after an eviction", () => {
  let now = 5_000;
  const original = new ServiceHealthState(() => now);
  for (let index = 0; index < FAILURE_THRESHOLD; index += 1) {
    original.recordFailure();
  }

  const stored = original.getStoredState();
  assert(stored);
  const recreated = new ServiceHealthState(() => now, stored);
  assert.deepEqual(recreated.getStatus(), original.getStatus());

  now += FAILURE_WINDOW_MS;
  assert.equal(recreated.getStatus().cooling_until, stored.cooling_until);
});

test("cooldown status fan-out uses the service concurrency limit", async () => {
  const serviceIds = Array.from(
    { length: SERVICE_FAN_OUT_CONCURRENCY * 2 },
    (_, index) => `service-${index}`,
  );
  let active = 0;
  let maximumActive = 0;
  const env = {
    HEALTH: {
      getByName: () => ({
        getStatus: async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise((resolve) => setTimeout(resolve, 10));
          active -= 1;
          return {
            failures: FAILURE_THRESHOLD,
            cooling_until: Date.now() + 60_000,
          };
        },
      }),
    },
  };

  const cooling = await listCoolingServices(env, serviceIds);

  assert.equal(cooling.length, serviceIds.length);
  assert.equal(maximumActive, SERVICE_FAN_OUT_CONCURRENCY);
});

test("health updates use waitUntil when it is available", async () => {
  let scheduled;
  const context = {
    waitUntil: (promise) => {
      scheduled = promise;
    },
  };
  let completed = false;
  await scheduleHealthUpdate(
    context,
    Promise.resolve().then(() => {
      completed = true;
    }),
  );
  assert(scheduled instanceof Promise);
  assert.equal(completed, true);
});

test("health updates fall back to awaiting when waitUntil is unavailable to an event", async () => {
  let completed = false;
  await scheduleHealthUpdate(
    {
      waitUntil() {
        throw new Error("event already completed");
      },
    },
    Promise.resolve().then(() => {
      completed = true;
    }),
  );
  assert.equal(completed, true);
});
