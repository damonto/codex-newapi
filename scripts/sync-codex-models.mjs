import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY = "openai/codex";
const RELEASE_API_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const TARGET_PATH = fileURLToPath(new URL("../src/codex-models.json", import.meta.url));

function githubHeaders() {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "codex-newapi-model-sync",
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

export function releaseTagFrom(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GitHub latest release response must be an object");
  }
  const tag = typeof value.tag_name === "string" ? value.tag_name.trim() : "";
  if (!/^rust-v\d+\.\d+\.\d+(?:[-+].+)?$/.test(tag)) {
    throw new Error(`latest Codex release has an unsupported tag: ${tag || "<missing>"}`);
  }
  return tag;
}

export function catalogUrlForTag(tag) {
  return `https://raw.githubusercontent.com/${REPOSITORY}/${tag}/codex-rs/models-manager/models.json`;
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
  onProgress(`Fetching latest release metadata from ${RELEASE_API_URL}`);
  const releaseText = await fetchText(RELEASE_API_URL, fetchImpl);
  let release;
  try {
    release = JSON.parse(releaseText);
  } catch (error) {
    throw new Error(`GitHub latest release response is not valid JSON: ${error.message}`);
  }
  const tag = releaseTagFrom(release);
  onProgress(`Resolved latest Rust release tag: ${tag}`);
  const sourceUrl = catalogUrlForTag(tag);
  onProgress(`Downloading model catalog from ${sourceUrl}`);
  const catalogText = await fetchText(sourceUrl, fetchImpl);
  const modelCount = validateCatalog(catalogText);
  onProgress(`Validated catalog structure (${modelCount} models)`);
  const changed = await replaceIfChanged(targetPath, catalogText);
  onProgress(changed ? "Writing updated catalog to disk" : "Catalog is unchanged; no file write needed");
  return { changed, modelCount, sourceUrl, tag, targetPath };
}

async function main() {
  const result = await syncCodexModels({
    onProgress: (message) => console.log(`[models:sync] ${message}`),
  });
  const target = relative(process.cwd(), result.targetPath) || result.targetPath;
  const action = result.changed ? "Synced" : "Already up to date:";
  console.log(`[models:sync] ${action} ${result.modelCount} Codex models from ${result.tag} to ${target}`);
}

const entryPoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entryPoint === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
