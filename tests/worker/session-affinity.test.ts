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
  type SessionAffinityResolution,
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

function digest(): string {
  return crypto.randomUUID().replaceAll("-", "").repeat(2);
}

function registration(sessionId: string) {
  return {
    registry_name: digest(),
    session_digest: digest(),
    session_id: sessionId,
  };
}

function requireResolution(
  resolution: SessionAffinityResolution | undefined,
): SessionAffinityResolution {
  expect(resolution).toBeDefined();
  if (!resolution) {
    throw new Error("expected session affinity resolution");
  }
  return resolution;
}

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
  const identity = registration("eviction-session");
  const stub = env.SESSION_AFFINITY.getByName(
    `${identity.registry_name}:${identity.session_digest}`,
  );
  const created = await stub.resolve(
    candidates,
    {
      service_id: "second",
      key_id: "second-a",
    },
    identity,
  );
  expect(created).toMatchObject({
    service_id: "second",
    key_id: "second-a",
    status: "created",
  });

  await evictDurableObject(stub);
  const hit = await stub.resolve(
    candidates,
    {
      service_id: "first",
      key_id: "first-a",
    },
    identity,
  );
  expect(hit).toMatchObject({
    service_id: "second",
    key_id: "second-a",
    status: "hit",
  });
});

test("concurrent first resolutions atomically converge on one binding", async () => {
  const identity = registration("concurrent-session");
  const stub = env.SESSION_AFFINITY.getByName(
    `${identity.registry_name}:${identity.session_digest}`,
  );
  const [left, right] = await Promise.all([
    stub.resolve(
      candidates,
      { service_id: "first", key_id: "first-a" },
      identity,
    ),
    stub.resolve(
      candidates,
      { service_id: "second", key_id: "second-a" },
      identity,
    ),
  ]);

  expect(left).toBeDefined();
  expect(right).toBeDefined();
  expect([left?.service_id, left?.key_id]).toEqual([
    right?.service_id,
    right?.key_id,
  ]);
  expect(new Set([left?.status, right?.status])).toEqual(
    new Set(["created", "hit"]),
  );
});

test("a removed target is rebound to the preferred current candidate", async () => {
  const identity = registration("rebound-session");
  const stub = env.SESSION_AFFINITY.getByName(
    `${identity.registry_name}:${identity.session_digest}`,
  );
  await stub.resolve(
    candidates,
    { service_id: "first", key_id: "first-b" },
    identity,
  );

  const rebound = await stub.resolve(
    [candidates[1]],
    {
      service_id: "second",
      key_id: "second-a",
    },
    identity,
  );
  expect(rebound).toMatchObject({
    service_id: "second",
    key_id: "second-a",
    status: "rebound",
  });
});

test("new managed bindings are indexed and conditionally cleared", async () => {
  const registryName = "d".repeat(64);
  const sessionDigest = "e".repeat(64);
  const stub = env.SESSION_AFFINITY.getByName(
    `${registryName}:${sessionDigest}`,
  );
  const created = requireResolution(
    await stub.resolve(
      candidates,
      { service_id: "first", key_id: "first-a" },
      {
        registry_name: registryName,
        session_digest: sessionDigest,
        session_id: "managed-session",
      },
    ),
  );
  expect(created.binding_id).toEqual(expect.any(String));
  expect(created.created_at).toEqual(expect.any(Number));
  expect(created.generation).toBe(1);
  expect(
    await env.SESSION_AFFINITY_INDEX.getByName(registryName).get(sessionDigest),
  ).toMatchObject({
    session_id: "managed-session",
    binding_id: created.binding_id,
  });
  expect(await stub.getStatus()).toMatchObject({ index_registered: true });

  expect(await stub.clearIfBindingId("wrong-binding", created.generation)).toBe(
    false,
  );
  expect(await stub.getStatus()).not.toBeNull();
  expect(
    await stub.clearIfBindingId(created.binding_id, created.generation),
  ).toBe(true);
  expect(await stub.getStatus()).toBeNull();
  expect(
    await env.SESSION_AFFINITY_INDEX.getByName(registryName).remove(
      sessionDigest,
      created.binding_id,
      created.generation,
    ),
  ).toBe(true);
  expect(
    await env.SESSION_AFFINITY_INDEX.getByName(registryName).get(sessionDigest),
  ).toBeNull();
});

test("managed bindings can be cleared without an index entry", async () => {
  const registryName = "4".repeat(64);
  const sessionDigest = "5".repeat(64);
  const registration = {
    registry_name: registryName,
    session_digest: sessionDigest,
    session_id: "unindexed-managed-session",
  };
  const stub = env.SESSION_AFFINITY.getByName(
    `${registryName}:${sessionDigest}`,
  );
  const created = requireResolution(
    await stub.resolve(
      candidates,
      { service_id: "first", key_id: "first-a" },
      registration,
    ),
  );
  const index = env.SESSION_AFFINITY_INDEX.getByName(registryName);
  await expect.poll(async () => await index.get(sessionDigest)).not.toBeNull();
  await index.remove(sessionDigest, created.binding_id, created.generation);

  expect(
    await stub.clearManaged({
      ...registration,
      session_id: "another-session",
    }),
  ).toBeNull();
  expect(await stub.getStatus()).not.toBeNull();
  expect(await stub.clearManaged(registration)).toEqual({
    binding_id: created.binding_id,
    generation: created.generation,
  });
  expect(await stub.getStatus()).toBeNull();
});

test("managed rebinds rotate binding identity and protect the replacement", async () => {
  const registryName = "8".repeat(64);
  const sessionDigest = "9".repeat(64);
  const stub = env.SESSION_AFFINITY.getByName(
    `${registryName}:${sessionDigest}`,
  );
  const registration = {
    registry_name: registryName,
    session_digest: sessionDigest,
    session_id: "rebound-managed-session",
  };
  const initial = requireResolution(
    await stub.resolve(
      [
        {
          service_id: "lower",
          priority: 10,
          keys: [{ key_id: "lower-key", priority: 10 }],
        },
      ],
      { service_id: "lower", key_id: "lower-key" },
      registration,
    ),
  );
  const upgraded = requireResolution(
    await stub.resolve(
      [
        {
          service_id: "lower",
          priority: 10,
          keys: [{ key_id: "lower-key", priority: 10 }],
        },
        {
          service_id: "higher",
          priority: 100,
          keys: [{ key_id: "higher-key", priority: 10 }],
        },
      ],
      { service_id: "higher", key_id: "higher-key" },
      registration,
    ),
  );

  expect(upgraded.status).toBe("rebound");
  expect(upgraded.binding_id).not.toBe(initial.binding_id);
  expect(upgraded.generation).toBeGreaterThan(initial.generation);
  expect(upgraded.created_at).toBeGreaterThanOrEqual(initial.created_at);
  expect(
    await stub.clearIfBindingId(initial.binding_id, initial.generation),
  ).toBe(false);
  expect(
    await env.SESSION_AFFINITY_INDEX.getByName(registryName).remove(
      sessionDigest,
      initial.binding_id,
      initial.generation,
    ),
  ).toBe(false);
  expect(await stub.getStatus()).toMatchObject({
    service_id: "higher",
    key_id: "higher-key",
    binding_id: upgraded.binding_id,
  });
  expect(
    await env.SESSION_AFFINITY_INDEX.getByName(registryName).get(sessionDigest),
  ).toMatchObject({ binding_id: upgraded.binding_id });
});

test("a stale equal-timestamp index entry is replaced by a newer generation", async () => {
  const registryName = "6".repeat(64);
  const sessionDigest = "7".repeat(64);
  const index = env.SESSION_AFFINITY_INDEX.getByName(registryName);
  await index.register({
    session_digest: sessionDigest,
    session_id: "generation-session",
    binding_id: "stale-binding",
    created_at: Date.now(),
    generation: 5,
  });
  const stub = env.SESSION_AFFINITY.getByName(
    `${registryName}:${sessionDigest}`,
  );
  const created = requireResolution(
    await stub.resolve(
      candidates,
      { service_id: "first", key_id: "first-a" },
      {
        registry_name: registryName,
        session_digest: sessionDigest,
        session_id: "generation-session",
      },
    ),
  );

  await expect
    .poll(async () => (await index.get(sessionDigest))?.generation)
    .toBe(6);
  const status = await stub.getStatus();
  expect(status).toMatchObject({
    binding_id: created.binding_id,
    created_at: created.created_at,
    generation: 6,
    index_registered: true,
  });
  expect(status?.binding_id).not.toBe("stale-binding");
  expect(await index.get(sessionDigest)).toMatchObject({
    binding_id: status?.binding_id,
    generation: 6,
  });
  expect(
    await stub.clearIfBindingId(created.binding_id, created.generation),
  ).toBe(false);
  expect(await stub.getStatus()).not.toBeNull();
});

test("a managed affinity alarm removes its index entry", async () => {
  const registryName = "2".repeat(64);
  const sessionDigest = "3".repeat(64);
  const stub = env.SESSION_AFFINITY.getByName(
    `${registryName}:${sessionDigest}`,
  );
  await stub.resolve(
    candidates,
    { service_id: "first", key_id: "first-a" },
    {
      registry_name: registryName,
      session_digest: sessionDigest,
      session_id: "expiring-session",
    },
  );
  await runInDurableObject(stub, async (_instance, state) => {
    const record = await state.storage.get<Record<string, unknown>>("affinity");
    await state.storage.put("affinity", {
      ...record,
      updated_at: Date.now() - SESSION_AFFINITY_TTL_MS - 1,
    });
    await state.storage.setAlarm(Date.now() + 60_000);
  });

  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(
    await env.SESSION_AFFINITY_INDEX.getByName(registryName).get(sessionDigest),
  ).toBeNull();
});

test("the idle alarm deletes affinity after 30 days", async () => {
  const identity = registration("alarm-session");
  const stub = env.SESSION_AFFINITY.getByName(
    `${identity.registry_name}:${identity.session_digest}`,
  );
  await stub.resolve(
    candidates,
    { service_id: "first", key_id: "first-a" },
    identity,
  );

  await runInDurableObject(stub, async (_instance, state) => {
    const record = await state.storage.get<Record<string, unknown>>("affinity");
    await state.storage.put("affinity", {
      ...record,
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

test("unsupported unmanaged affinity records do not participate in routing", async () => {
  const identity = registration("unmanaged-session");
  const stub = env.SESSION_AFFINITY.getByName(
    `${identity.registry_name}:${identity.session_digest}`,
  );
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put("affinity", {
      service_id: "second",
      key_id: "second-a",
      updated_at: Date.now(),
    });
  });

  const resolution = await stub.resolve(
    candidates,
    { service_id: "first", key_id: "first-a" },
    identity,
  );

  expect(resolution).toMatchObject({
    service_id: "first",
    key_id: "first-a",
    generation: 1,
    status: "created",
  });
});

test("unsupported generation-less managed records are replaced", async () => {
  const identity = registration("generation-less-session");
  const stub = env.SESSION_AFFINITY.getByName(
    `${identity.registry_name}:${identity.session_digest}`,
  );
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put("affinity", {
      service_id: "second",
      key_id: "second-a",
      updated_at: Date.now(),
      binding_id: "old-binding",
      created_at: Date.now(),
      registry_name: identity.registry_name,
      session_digest: identity.session_digest,
      session_id: identity.session_id,
      index_registered: true,
    });
  });

  const resolution = await stub.resolve(
    candidates,
    { service_id: "first", key_id: "first-a" },
    identity,
  );

  expect(resolution).toMatchObject({
    service_id: "first",
    key_id: "first-a",
    generation: 1,
    status: "created",
  });
  expect(resolution?.binding_id).not.toBe("old-binding");
});
