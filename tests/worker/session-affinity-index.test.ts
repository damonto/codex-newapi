import { env } from "cloudflare:workers";
import { expect, test } from "vitest";

const digest = (value: string): string => value.repeat(64);

test("session affinity indexes paginate and remove only matching bindings", async () => {
  const stub = env.SESSION_AFFINITY_INDEX.getByName(`index-${crypto.randomUUID()}`);
  const entries = [
    {
      session_digest: digest("a"),
      session_id: "first",
      binding_id: "binding-first",
      created_at: 1,
      generation: 1,
    },
    {
      session_digest: digest("b"),
      session_id: "second",
      binding_id: "binding-second",
      created_at: 2,
      generation: 1,
    },
    {
      session_digest: digest("c"),
      session_id: "third",
      binding_id: "binding-third",
      created_at: 3,
      generation: 1,
    },
  ];
  for (const entry of entries) {
    await stub.register(entry);
  }

  const first = await stub.listPage(null, 2);
  expect(first).toEqual({
    data: entries.slice(0, 2),
    next_cursor: digest("b"),
  });
  expect(await stub.listPage(first.next_cursor, 2)).toEqual({
    data: entries.slice(2),
    next_cursor: null,
  });

  expect(await stub.remove(digest("a"), "wrong-binding")).toBe(false);
  expect(await stub.get(digest("a"))).toEqual(entries[0]);
  expect(await stub.remove(digest("a"), "binding-first")).toBe(true);
  expect(await stub.get(digest("a"))).toBeNull();
});

test("an index upsert protects a replacement binding from stale deletion", async () => {
  const stub = env.SESSION_AFFINITY_INDEX.getByName(`replace-${crypto.randomUUID()}`);
  const sessionDigest = digest("d");
  await stub.register({
    session_digest: sessionDigest,
    session_id: "session",
    binding_id: "old-binding",
    created_at: 10,
    generation: 1,
  });
  await stub.register({
    session_digest: sessionDigest,
    session_id: "session",
    binding_id: "new-binding",
    created_at: 10,
    generation: 2,
  });
  await stub.register({
    session_digest: sessionDigest,
    session_id: "session",
    binding_id: "old-binding",
    created_at: 999,
    generation: 1,
  });

  expect(await stub.remove(sessionDigest, "old-binding")).toBe(false);
  expect(await stub.get(sessionDigest)).toEqual({
    session_digest: sessionDigest,
    session_id: "session",
    binding_id: "new-binding",
    created_at: 10,
    generation: 2,
  });
});
