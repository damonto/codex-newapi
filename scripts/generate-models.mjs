import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY = "openai/codex";
const SOURCE_REF = "main";
export const CATALOG_URL = `https://raw.githubusercontent.com/${REPOSITORY}/${SOURCE_REF}/codex-rs/models-manager/models.json`;
export const FETCH_TIMEOUT_MS = 30_000;
const CODEX_FILE_NAME = "codex.json";
export const MODELS_DIRECTORY = fileURLToPath(
  new URL("./models", import.meta.url),
);
export const CODEX_TARGET_PATH = fileURLToPath(
  new URL("./models/codex.json", import.meta.url),
);
export const TARGET_PATH = fileURLToPath(
  new URL("../src/models.json", import.meta.url),
);

function githubHeaders() {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "cody-model-sync",
    "x-github-api-version": "2022-11-28",
  };
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

async function fetchText(url, fetchImpl, timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: githubHeaders(),
      redirect: "follow",
      signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `request to ${url} failed with ${response.status}: ${text.slice(0, 300)}`,
      );
    }
    return text;
  } catch (error) {
    if (signal.aborted) {
      throw new Error(`request to ${url} timed out after ${timeoutMs}ms`, {
        cause: error,
      });
    }
    throw error;
  }
}

function parseJson(text, source) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${source} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateCatalogValue(value, source) {
  if (!isObject(value)) {
    throw new Error(`${source} must be an object`);
  }
  if (!Array.isArray(value.models) || value.models.length === 0) {
    throw new Error(`${source} must contain a non-empty models array`);
  }

  const slugs = new Set();
  for (const [index, model] of value.models.entries()) {
    const slug =
      typeof model === "object" && model !== null && !Array.isArray(model)
        ? model.slug
        : undefined;
    if (typeof slug !== "string" || slug.trim() === "") {
      throw new Error(`${source} has an invalid slug at models[${index}]`);
    }
    if (slugs.has(slug)) {
      throw new Error(`${source} contains duplicate slug ${slug}`);
    }
    slugs.add(slug);
  }
  return value.models;
}

function parseCatalogText(text, source) {
  return validateCatalogValue(parseJson(text, source), source);
}

function hasErrorCode(error, code) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

export function validateCatalog(text) {
  return parseCatalogText(text, "downloaded Codex model catalog").length;
}

async function replaceIfChanged(path, text) {
  let current;
  try {
    current = await readFile(path, "utf8");
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
  if (current === text) {
    return false;
  }

  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, text, "utf8");
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return true;
}

async function prepareMergedCatalog({
  modelsDirectory = MODELS_DIRECTORY,
  catalogOverrides = new Map(),
} = {}) {
  const entries = await readdir(modelsDirectory, { withFileTypes: true });
  const fileNames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .concat(
      [...catalogOverrides.keys()].filter(
        (fileName) => fileName.endsWith(".json") && !entries.some(
          (entry) => entry.isFile() && entry.name === fileName,
        ),
      ),
    )
    .sort();
  if (fileNames.length === 0) {
    throw new Error(`no JSON model catalogs found in ${modelsDirectory}`);
  }

  const models = [];
  const sourcesBySlug = new Map();
  for (const fileName of fileNames) {
    const source = resolve(modelsDirectory, fileName);
    const isOverride = catalogOverrides.has(fileName);
    const sourceLabel = isOverride ? "downloaded Codex model catalog" : source;
    const modelsForFile = isOverride
      ? catalogOverrides.get(fileName)
      : parseCatalogText(await readFile(source, "utf8"), source);
    for (const [index, model] of modelsForFile.entries()) {
      const previousSource = sourcesBySlug.get(model.slug);
      if (previousSource) {
        throw new Error(
          `duplicate model slug ${model.slug} in ${sourceLabel} and ${previousSource}`,
        );
      }
      sourcesBySlug.set(
        model.slug,
        `${sourceLabel} models[${index}]`,
      );
      models.push(model);
    }
  }

  return {
    fileCount: fileNames.length,
    modelCount: models.length,
    sourceFiles: fileNames,
    text: `${JSON.stringify({ models }, null, 2)}\n`,
  };
}

export async function mergeModelCatalogs({
  modelsDirectory = MODELS_DIRECTORY,
  targetPath = TARGET_PATH,
} = {}) {
  const prepared = await prepareMergedCatalog({ modelsDirectory });
  const changed = await replaceIfChanged(targetPath, prepared.text);
  return {
    changed,
    fileCount: prepared.fileCount,
    modelCount: prepared.modelCount,
    sourceFiles: prepared.sourceFiles,
    targetPath,
  };
}

export async function syncCodexModels({
  fetchImpl = fetch,
  fetchTimeoutMs = FETCH_TIMEOUT_MS,
  onProgress = () => {},
  codexTargetPath = CODEX_TARGET_PATH,
  modelsDirectory = MODELS_DIRECTORY,
  targetPath = TARGET_PATH,
} = {}) {
  onProgress(`Downloading model catalog from ${CATALOG_URL}`);
  const catalogText = await fetchText(CATALOG_URL, fetchImpl, fetchTimeoutMs);
  const codexCatalog = parseCatalogText(
    catalogText,
    "downloaded Codex model catalog",
  );
  onProgress(`Validated catalog structure (${codexCatalog.length} models)`);

  const prepared = await prepareMergedCatalog({
    modelsDirectory,
    catalogOverrides: new Map([
      [
        CODEX_FILE_NAME,
        codexCatalog,
      ],
    ]),
  });

  const codexChanged = await replaceIfChanged(codexTargetPath, catalogText);
  onProgress(
    codexChanged
      ? "Writing updated Codex catalog to scripts/models/codex.json"
      : "Codex catalog is unchanged; no file write needed",
  );

  const mergedChanged = await replaceIfChanged(targetPath, prepared.text);
  onProgress(
    mergedChanged
      ? "Writing merged model catalog to src/models.json"
      : "Merged model catalog is unchanged; no file write needed",
  );
  return {
    changed: codexChanged || mergedChanged,
    codexChanged,
    codexModelCount: codexCatalog.length,
    fileCount: prepared.fileCount,
    modelCount: prepared.modelCount,
    sourceRef: SOURCE_REF,
    sourceUrl: CATALOG_URL,
    sourceFiles: prepared.sourceFiles,
    targetPath,
  };
}

async function main() {
  const result = await syncCodexModels({
    onProgress: (message) => console.log(`[models:sync] ${message}`),
  });
  const target =
    relative(process.cwd(), result.targetPath) || result.targetPath;
  const action = result.changed ? "Generated" : "Already up to date:";
  console.log(
    `[models:sync] ${action} ${result.modelCount} models from ${result.fileCount} catalogs to ${target}`,
  );
}

const entryPoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (entryPoint === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
