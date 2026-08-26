import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CATALOG_URL,
  mergeModelCatalogs,
  syncCodexModels,
  validateCatalog,
} from "../scripts/generate-models.mjs";

test("catalog URL points to the Codex main branch", () => {
  assert.equal(
    CATALOG_URL,
    "https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json",
  );
});

test("syncCodexModels downloads and merges the catalog files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-model-sync-"));
  const modelsDirectory = join(directory, "models");
  const codexTargetPath = join(modelsDirectory, "codex.json");
  const targetPath = join(directory, "merged.json");
  const catalog = '{"models":[{"slug":"model-a"}]}';
  const requestedUrls = [];

  try {
    await mkdir(modelsDirectory);
    const result = await syncCodexModels({
      fetchImpl: async (url) => {
        requestedUrls.push(url);
        return new Response(catalog);
      },
      codexTargetPath,
      modelsDirectory,
      targetPath,
    });

    assert.deepEqual(requestedUrls, [CATALOG_URL]);
    assert.equal(result.sourceRef, "main");
    assert.equal(result.sourceUrl, CATALOG_URL);
    assert.equal(result.codexModelCount, 1);
    assert.equal(result.fileCount, 1);
    assert.equal(result.modelCount, 1);
    assert.equal(await readFile(codexTargetPath, "utf8"), catalog);
    assert.deepEqual(JSON.parse(await readFile(targetPath, "utf8")), {
      models: [{ slug: "model-a" }],
    });

    const codexMtime = (await stat(codexTargetPath)).mtimeMs;
    const targetMtime = (await stat(targetPath)).mtimeMs;
    const unchanged = await syncCodexModels({
      fetchImpl: async () => new Response(catalog),
      codexTargetPath,
      modelsDirectory,
      targetPath,
    });
    assert.equal(unchanged.changed, false);
    assert.equal(unchanged.codexChanged, false);
    assert.equal((await stat(codexTargetPath)).mtimeMs, codexMtime);
    assert.equal((await stat(targetPath)).mtimeMs, targetMtime);
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

test("mergeModelCatalogs sorts source files and preserves model order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "model-catalog-"));
  const modelsDirectory = join(directory, "models");
  const targetPath = join(directory, "models.json");

  try {
    await mkdir(modelsDirectory);
    await writeFile(
      join(modelsDirectory, "zai.json"),
      '{"models":[{"slug":"zai-model"}]}',
    );
    await writeFile(
      join(modelsDirectory, "codex.json"),
      '{"models":[{"slug":"codex-model-1"},{"slug":"codex-model-2"}]}',
    );
    await writeFile(
      join(modelsDirectory, "deepseek.json"),
      '{"models":[{"slug":"deepseek-model"}]}',
    );

    const result = await mergeModelCatalogs({ modelsDirectory, targetPath });

    assert.deepEqual(result.sourceFiles, [
      "codex.json",
      "deepseek.json",
      "zai.json",
    ]);
    assert.equal(result.fileCount, 3);
    assert.equal(result.modelCount, 4);
    assert.deepEqual(
      JSON.parse(await readFile(targetPath, "utf8")).models.map(
        (model) => model.slug,
      ),
      ["codex-model-1", "codex-model-2", "deepseek-model", "zai-model"],
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("mergeModelCatalogs rejects duplicate slugs across files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "model-catalog-"));
  const modelsDirectory = join(directory, "models");
  const targetPath = join(directory, "models.json");

  try {
    await mkdir(modelsDirectory);
    await writeFile(
      join(modelsDirectory, "a.json"),
      '{"models":[{"slug":"duplicate"}]}',
    );
    await writeFile(
      join(modelsDirectory, "b.json"),
      '{"models":[{"slug":"duplicate"}]}',
    );

    await assert.rejects(
      mergeModelCatalogs({ modelsDirectory, targetPath }),
      /duplicate model slug duplicate/,
    );
    await assert.rejects(readFile(targetPath), { code: "ENOENT" });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("mergeModelCatalogs rejects invalid JSON and empty model lists", async () => {
  const directory = await mkdtemp(join(tmpdir(), "model-catalog-"));
  const modelsDirectory = join(directory, "models");
  const targetPath = join(directory, "models.json");

  try {
    await mkdir(modelsDirectory);
    await writeFile(join(modelsDirectory, "invalid.json"), "not json");
    await assert.rejects(
      mergeModelCatalogs({ modelsDirectory, targetPath }),
      /invalid\.json is not valid JSON/,
    );

    await writeFile(
      join(modelsDirectory, "invalid.json"),
      '{"models":[]}',
    );
    await assert.rejects(
      mergeModelCatalogs({ modelsDirectory, targetPath }),
      /must contain a non-empty models array/,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("syncCodexModels times out a stalled download", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-model-sync-"));

  try {
    await assert.rejects(
      syncCodexModels({
        fetchImpl: async (_url, init) => ({
          ok: true,
          text: async () => {
            await new Promise((resolve) => {
              init.signal.addEventListener("abort", resolve, { once: true });
            });
            throw new Error("aborted");
          },
        }),
        fetchTimeoutMs: 1,
        modelsDirectory: directory,
        targetPath: join(directory, "merged.json"),
        codexTargetPath: join(directory, "codex.json"),
      }),
      /timed out after 1ms/,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("syncCodexModels validates all catalogs before writing either output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-model-sync-"));
  const modelsDirectory = join(directory, "models");
  const codexTargetPath = join(modelsDirectory, "codex.json");
  const targetPath = join(directory, "merged.json");
  const oldCodex = '{"models":[{"slug":"old-codex"}]}';
  const oldMerged = '{"models":[{"slug":"old-merged"}]}\n';

  try {
    await mkdir(modelsDirectory);
    await writeFile(codexTargetPath, oldCodex);
    await writeFile(targetPath, oldMerged);
    await writeFile(
      join(modelsDirectory, "provider.json"),
      '{"models":[{"slug":"duplicate"}]}',
    );

    await assert.rejects(
      syncCodexModels({
        fetchImpl: async () =>
          new Response('{"models":[{"slug":"duplicate"}]}'),
        codexTargetPath,
        modelsDirectory,
        targetPath,
      }),
      /duplicate model slug duplicate/,
    );
    assert.equal(await readFile(codexTargetPath, "utf8"), oldCodex);
    assert.equal(await readFile(targetPath, "utf8"), oldMerged);

    await writeFile(join(modelsDirectory, "provider.json"), "not json");
    await assert.rejects(
      syncCodexModels({
        fetchImpl: async () =>
          new Response('{"models":[{"slug":"new-codex"}]}'),
        codexTargetPath,
        modelsDirectory,
        targetPath,
      }),
      /provider\.json is not valid JSON/,
    );
    assert.equal(await readFile(codexTargetPath, "utf8"), oldCodex);
    assert.equal(await readFile(targetPath, "utf8"), oldMerged);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
