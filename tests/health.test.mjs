import assert from "node:assert/strict";
import test from "node:test";

import {
  FAILURE_THRESHOLD,
  FAILURE_WINDOW_MS,
  recordServiceFailure,
  scheduleHealthUpdate,
  serviceIsAvailable,
  ServiceHealth,
} from "../src/health.ts";

test("ten consecutive failures start a cooldown and success resets state", async () => {
  const health = new ServiceHealth({}, {});
  for (let index = 0; index < FAILURE_THRESHOLD; index += 1) {
    await health.fetch(new Request("https://health/failure", { method: "POST" }));
  }

  let response = await health.fetch(new Request("https://health/status"));
  let snapshot = await response.json();
  assert.equal(snapshot.failures, FAILURE_THRESHOLD);
  assert.equal(typeof snapshot.cooling_until, "number");

  response = await health.fetch(new Request("https://health/success", { method: "POST" }));
  snapshot = await response.json();
  assert.deepEqual(snapshot, { failures: 0, cooling_until: null });
});

test("failures outside the five-minute window do not join the same streak", async () => {
  let now = 1_000;
  const health = new ServiceHealth({}, {}, () => now);

  for (let index = 0; index < FAILURE_THRESHOLD - 1; index += 1) {
    await health.fetch(new Request("https://health/failure", { method: "POST" }));
  }

  now += FAILURE_WINDOW_MS;
  await health.fetch(new Request("https://health/failure", { method: "POST" }));

  const response = await health.fetch(new Request("https://health/status"));
  const snapshot = await response.json();
  assert.deepEqual(snapshot, { failures: 1, cooling_until: null });
});

test("an expired failure window is cleared when health is read", async () => {
  let now = 3_000;
  const health = new ServiceHealth({}, {}, () => now);
  await health.fetch(new Request("https://health/failure", { method: "POST" }));

  now += FAILURE_WINDOW_MS;
  const response = await health.fetch(new Request("https://health/status"));
  const snapshot = await response.json();
  assert.deepEqual(snapshot, { failures: 0, cooling_until: null });
});

test("ten failures inside one five-minute window start a cooldown", async () => {
  let now = 2_000;
  const health = new ServiceHealth({}, {}, () => now);

  for (let index = 0; index < FAILURE_THRESHOLD; index += 1) {
    now += 20_000;
    await health.fetch(new Request("https://health/failure", { method: "POST" }));
  }

  const response = await health.fetch(new Request("https://health/status"));
  const snapshot = await response.json();
  assert.equal(snapshot.failures, FAILURE_THRESHOLD);
  assert.equal(typeof snapshot.cooling_until, "number");
});

test("catalog health is isolated from inference health", async () => {
  const objects = new Map([
    ["service", new ServiceHealth({}, {})],
    ["service:catalog", new ServiceHealth({}, {})],
  ]);
  const env = {
    HEALTH: {
      idFromName: (name) => name,
      get: (id) => ({
        fetch: (input, init) => objects.get(id).fetch(
          input instanceof Request ? input : new Request(input, init),
        ),
      }),
    },
  };
  for (let index = 0; index < FAILURE_THRESHOLD; index += 1) {
    await recordServiceFailure(env, "service", "test", "catalog");
  }
  assert.equal(await serviceIsAvailable(env, "service", "test", "inference"), true);
  assert.equal(await serviceIsAvailable(env, "service", "test", "catalog"), false);
});

test("health updates use waitUntil when it is available", async () => {
  let scheduled;
  const context = {
    waitUntil: (promise) => {
      scheduled = promise;
    },
  };
  let completed = false;
  await scheduleHealthUpdate(context, Promise.resolve().then(() => {
    completed = true;
  }));
  assert(scheduled instanceof Promise);
  assert.equal(completed, true);
});
