import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { expect, test } from "vitest";

import {
  affinityObjectName,
  SESSION_AFFINITY_TTL_MS,
  type AffinityServiceCandidate,
} from "../../src/session-affinity.ts";

const candidates: AffinityServiceCandidate[] = [
  {
    service_id: "first",
    priority: 10,
    keys: [
      { key_id: "first-a", priority: 10 },
      { key_id: "first-b", priority: 10 },
    ],
  },
  {
    service_id: "second",
    priority: 10,
    keys: [{ key_id: "second-a", priority: 10 }],
  },
];

test("affinity object names isolate client credentials and sessions", async () => {
  const first = await affinityObjectName("client-secret-a", "session-a");
  const repeated = await affinityObjectName("client-secret-a", "session-a");
  const otherClient = await affinityObjectName("client-secret-b", "session-a");
  const otherSession = await affinityObjectName("client-secret-a", "session-b");

  expect(first).toBe(repeated);
  expect(first).toMatch(/^[a-f0-9]{64}:[a-f0-9]{64}$/);
  expect(first).not.toContain("client-secret-a");
  expect(first).not.toContain("session-a");
  expect(otherClient).not.toBe(first);
  expect(otherSession).not.toBe(first);
});

test("session affinity survives eviction and keeps the original target", async () => {
  const stub = env.SESSION_AFFINITY.getByName(`eviction-${crypto.randomUUID()}`);
  const created = await stub.resolve(candidates, {
    service_id: "second",
    key_id: "second-a",
  });
  expect(created).toMatchObject({
    service_id: "second",
    key_id: "second-a",
    status: "created",
  });

  await evictDurableObject(stub);
  const hit = await stub.resolve(candidates, {
    service_id: "first",
    key_id: "first-a",
  });
  expect(hit).toMatchObject({
    service_id: "second",
    key_id: "second-a",
    status: "hit",
  });
});

test("concurrent first resolutions atomically converge on one binding", async () => {
  const stub = env.SESSION_AFFINITY.getByName(`concurrent-${crypto.randomUUID()}`);
  const [left, right] = await Promise.all([
    stub.resolve(candidates, { service_id: "first", key_id: "first-a" }),
    stub.resolve(candidates, { service_id: "second", key_id: "second-a" }),
  ]);

  expect(left).toBeDefined();
  expect(right).toBeDefined();
  expect([left?.service_id, left?.key_id]).toEqual([
    right?.service_id,
    right?.key_id,
  ]);
  expect(new Set([left?.status, right?.status])).toEqual(new Set(["created", "hit"]));
});

test("a removed target is rebound to the preferred current candidate", async () => {
  const stub = env.SESSION_AFFINITY.getByName(`rebound-${crypto.randomUUID()}`);
  await stub.resolve(candidates, { service_id: "first", key_id: "first-b" });

  const rebound = await stub.resolve([candidates[1]], {
    service_id: "second",
    key_id: "second-a",
  });
  expect(rebound).toMatchObject({
    service_id: "second",
    key_id: "second-a",
    status: "rebound",
  });
});

test("the idle alarm deletes affinity after 30 days", async () => {
  const stub = env.SESSION_AFFINITY.getByName(`alarm-${crypto.randomUUID()}`);
  await stub.resolve(candidates, { service_id: "first", key_id: "first-a" });

  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put("affinity", {
      service_id: "first",
      key_id: "first-a",
      updated_at: Date.now() - SESSION_AFFINITY_TTL_MS - 1,
    });
    await state.storage.setAlarm(Date.now() + 60_000);
  });

  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(await stub.getStatus()).toBeNull();
  await runInDurableObject(stub, async (_instance, state) => {
    expect(await state.storage.get("affinity")).toBeUndefined();
  });
});
