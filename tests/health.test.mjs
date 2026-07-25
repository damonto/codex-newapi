import assert from "node:assert/strict";
import test from "node:test";

import {
  FAILURE_THRESHOLD,
  FAILURE_WINDOW_MS,
  isHealthFailureStatus,
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

test("only HTTP 400 and 503 are failure statuses", () => {
  assert.equal(isHealthFailureStatus(400), true);
  assert.equal(isHealthFailureStatus(503), true);
  assert.equal(isHealthFailureStatus(401), false);
  assert.equal(isHealthFailureStatus(429), false);
  assert.equal(isHealthFailureStatus(500), false);
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
