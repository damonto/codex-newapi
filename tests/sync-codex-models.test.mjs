import assert from "node:assert/strict";
import test from "node:test";

import {
  catalogUrlForTag,
  releaseTagFrom,
  validateCatalog,
} from "../scripts/sync-codex-models.mjs";

test("releaseTagFrom accepts a stable Codex Rust release", () => {
  assert.equal(releaseTagFrom({ tag_name: "rust-v0.145.0" }), "rust-v0.145.0");
});

test("releaseTagFrom rejects unrelated repository releases", () => {
  assert.throws(() => releaseTagFrom({ tag_name: "codex-zsh-v0.1.0" }), /unsupported tag/);
});

test("catalogUrlForTag builds the raw GitHub catalog URL", () => {
  assert.equal(
    catalogUrlForTag("rust-v0.145.0"),
    "https://raw.githubusercontent.com/openai/codex/rust-v0.145.0/codex-rs/models-manager/models.json",
  );
});

test("validateCatalog rejects duplicate or missing model slugs", () => {
  assert.equal(validateCatalog('{"models":[{"slug":"model-a"}]}'), 1);
  assert.throws(
    () => validateCatalog('{"models":[{"slug":"model-a"},{"slug":"model-a"}]}'),
    /duplicate slug/,
  );
  assert.throws(() => validateCatalog('{"models":[{}]}'), /invalid slug/);
});
