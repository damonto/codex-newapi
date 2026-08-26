import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY = "openai/codex";
const SOURCE_REF = "main";
export const CATALOG_URL = `https://raw.githubusercontent.com/${REPOSITORY}/${SOURCE_REF}/codex-rs/models-manager/models.json`;
const TARGET_PATH = fileURLToPath(new URL("../src/codex-models.json", import.meta.url));

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

async function fetchText(url, fetchImpl) {
  const response = await fetchImpl(url, { headers: githubHeaders(), redirect: "follow" });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`request to ${url} failed with ${response.status}: ${text.slice(0, 300)}`);
  }
  return text;
}

export function validateCatalog(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`downloaded Codex model catalog is not valid JSON: ${error.message}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("downloaded Codex model catalog must be an object");
  }
  if (!Array.isArray(value.models) || value.models.length === 0) {
    throw new Error("downloaded Codex model catalog must contain a non-empty models array");
  }

  const slugs = new Set();
  for (const [index, model] of value.models.entries()) {
    const slug =
      typeof model === "object" && model !== null && !Array.isArray(model)
        ? model.slug
        : undefined;
    if (typeof slug !== "string" || slug.trim() === "") {
      throw new Error(`downloaded Codex model catalog has an invalid slug at models[${index}]`);
    }
    if (slugs.has(slug)) {
      throw new Error(`downloaded Codex model catalog contains duplicate slug ${slug}`);
    }
    slugs.add(slug);
  }
  return value.models.length;
}

async function replaceIfChanged(path, text) {
  let current;
  try {
    current = await readFile(path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
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

export async function syncCodexModels({
  fetchImpl = fetch,
  onProgress = () => {},
  targetPath = TARGET_PATH,
} = {}) {
  onProgress(`Downloading model catalog from ${CATALOG_URL}`);
  const catalogText = await fetchText(CATALOG_URL, fetchImpl);
  const modelCount = validateCatalog(catalogText);
  onProgress(`Validated catalog structure (${modelCount} models)`);
  const changed = await replaceIfChanged(targetPath, catalogText);
  onProgress(changed ? "Writing updated catalog to disk" : "Catalog is unchanged; no file write needed");
  return { changed, modelCount, sourceRef: SOURCE_REF, sourceUrl: CATALOG_URL, targetPath };
}

async function main() {
  const result = await syncCodexModels({
    onProgress: (message) => console.log(`[models:sync] ${message}`),
  });
  const target = relative(process.cwd(), result.targetPath) || result.targetPath;
  const action = result.changed ? "Synced" : "Already up to date:";
  console.log(
    `[models:sync] ${action} ${result.modelCount} Codex models from ${result.sourceRef} to ${target}`,
  );
}

const entryPoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entryPoint === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
