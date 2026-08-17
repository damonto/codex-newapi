import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CATALOG_URL,
  syncCodexModels,
  validateCatalog,
} from "../scripts/sync-codex-models.mjs";

test("catalog URL points to the Codex main branch", () => {
  assert.equal(
    CATALOG_URL,
    "https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json",
  );
});

test("syncCodexModels downloads the catalog directly from main", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-model-sync-"));
  const targetPath = join(directory, "models.json");
  const catalog = '{"models":[{"slug":"model-a"}]}';
  const requestedUrls = [];

  try {
    const result = await syncCodexModels({
      fetchImpl: async (url) => {
        requestedUrls.push(url);
        return new Response(catalog);
      },
      targetPath,
    });

    assert.deepEqual(requestedUrls, [CATALOG_URL]);
    assert.equal(result.sourceRef, "main");
    assert.equal(result.sourceUrl, CATALOG_URL);
    assert.equal(await readFile(targetPath, "utf8"), catalog);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("validateCatalog rejects duplicate or missing model slugs", () => {
  assert.equal(validateCatalog('{"models":[{"slug":"model-a"}]}'), 1);
  assert.throws(
    () => validateCatalog('{"models":[{"slug":"model-a"},{"slug":"model-a"}]}'),
    /duplicate slug/,
  );
  assert.throws(() => validateCatalog('{"models":[{}]}'), /invalid slug/);
});
