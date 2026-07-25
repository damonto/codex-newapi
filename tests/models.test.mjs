import assert from "node:assert/strict";
import test from "node:test";

import { aggregateCodexModels, aggregateStandardModels } from "../src/models.ts";

const results = [
  {
    service: { id: "primary", models: ["grok-4.5"] },
    success: true,
    models: [
      {
        id: "grok-4.5",
        raw: { id: "grok-4.5", object: "model", owned_by: "newapi" },
      },
    ],
  },
];

test("standard aggregation adds an alias without hiding the upstream model", () => {
  const models = aggregateStandardModels(results, { "gpt-5.6-sol": "grok-4.5" });
  assert.deepEqual(models.map((model) => model.id), ["grok-4.5", "gpt-5.6-sol"]);
});

test("Codex aggregation only returns exact catalog matches", () => {
  const models = aggregateCodexModels(new Set(["grok-4.5", "gpt-5.6-sol", "codex-auto-review"]));
  assert.deepEqual(
    models.map((model) => model.slug),
    ["gpt-5.6-sol", "codex-auto-review"],
  );
});
