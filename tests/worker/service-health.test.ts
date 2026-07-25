import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";

import { FAILURE_THRESHOLD } from "../../src/health.ts";

test("failure streaks and cooldowns survive Durable Object eviction", async () => {
  const stub = env.HEALTH.getByName("eviction-test");
  for (let index = 0; index < FAILURE_THRESHOLD - 1; index += 1) {
    await stub.recordFailure();
  }

  await evictDurableObject(stub);
  const cooling = await stub.recordFailure();
  expect(cooling.failures).toBe(FAILURE_THRESHOLD);
  expect(cooling.cooling_until).toBeTypeOf("number");

  await evictDurableObject(stub);
  expect(await stub.getStatus()).toEqual(cooling);

  await stub.clear();
  await evictDurableObject(stub);
  expect(await stub.getStatus()).toEqual({ failures: 0, cooling_until: null });
});
