import codexCatalog from "./codex-models.json" with { type: "json" };
import { discardBody, readBodyWithinLimit } from "./body.ts";
import {
  forwardRequestHeaders,
  jsonResponse,
  openAiError,
  shouldStripRequestHeader,
  upstreamUrl,
} from "./http.ts";
import {
  recordServiceFailure,
  recordServiceSuccess,
  isHealthFailureStatus,
  scheduleHealthUpdate,
  serviceIsAvailable,
  type HealthExecutionContext,
} from "./health.ts";
import {
  allowedServices,
  serviceSupportsAutoReview,
} from "./routing.ts";
import {
  elapsedMs,
  errorMessage,
  logInfo,
  logWarn,
  registerSensitiveValues,
} from "./log.ts";
import type {
  ClientApiKeyConfig,
  GatewayConfig,
  ServiceConfig,
} from "./types.ts";

export const MODEL_CATALOG_TIMEOUT_MS = 3_000;
export const MAX_MODEL_CATALOG_BODY_BYTES = 8 * 1024 * 1024;
export const MODEL_CATALOG_CONCURRENCY = 6;
export const DEFAULT_MODELS_CACHE_TTL_SECONDS = 30;
export const MAX_MODELS_CACHE_TTL_SECONDS = 300;

type JsonObject = Record<string, unknown>;

interface UpstreamModel {
  id: string;
  raw: JsonObject;
}

interface ServiceModelsResult {
  service: ServiceConfig;
  success: boolean;
  models: UpstreamModel[];
}

interface ModelsCacheEntry {
  expiresAt: number;
  payload: JsonObject;
}

class ModelsRequestError extends Error {
  constructor(
    readonly status: number,
    readonly messageText: string,
    readonly type: string,
    readonly code: string,
  ) {
    super(messageText);
    this.name = "ModelsRequestError";
  }
}

let modelsCache = new Map<string, ModelsCacheEntry>();
let modelsInFlight = new Map<string, Promise<JsonObject>>();

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseUpstreamModels(value: unknown): UpstreamModel[] | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const list = Array.isArray(value.data)
    ? value.data
    : Array.isArray(value.models)
      ? value.models
      : undefined;
  if (!list) {
    return undefined;
  }
  const models: UpstreamModel[] = [];
  for (const entry of list) {
    if (!isObject(entry)) {
      continue;
    }
    const id = typeof entry.id === "string"
      ? entry.id
      : typeof entry.slug === "string"
        ? entry.slug
        : undefined;
    if (id) {
      models.push({ id, raw: entry });
    }
  }
  return models;
}

function timeoutError(): Error {
  return new Error(`model catalog request timed out after ${MODEL_CATALOG_TIMEOUT_MS}ms`);
}

async function fetchCatalogResponse(
  url: string,
  init: RequestInit,
): Promise<{ response: Response; body?: unknown }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operation = (async () => {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    if (!response.ok) {
      await discardBody(response.body);
      return { response };
    }
    const rawBody = await readBodyWithinLimit(
      response.body,
      MAX_MODEL_CATALOG_BODY_BYTES,
      response.headers.get("content-length"),
    );
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(rawBody)) as unknown;
    } catch {
      throw new Error("model catalog response must be valid JSON");
    }
    return {
      response,
      body,
    };
  })();
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(timeoutError());
    }, MODEL_CATALOG_TIMEOUT_MS);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function fetchServiceModels(
  request: Request,
  env: Env,
  config: GatewayConfig,
  service: ServiceConfig,
  requestId: string,
  context?: HealthExecutionContext,
): Promise<ServiceModelsResult> {
  const incomingUrl = new URL(request.url);
  const headers = forwardRequestHeaders(request, service.api_key);
  const startedAt = performance.now();
  logInfo("models.upstream.request", {
    request_id: requestId,
    service_id: service.id,
  });

  try {
    const result = await fetchCatalogResponse(
      upstreamUrl(service, "models", incomingUrl.search),
      {
        method: "GET",
        headers,
        redirect: "manual",
      },
    );
    if (!result.response.ok) {
      logWarn("models.upstream.failed", {
        request_id: requestId,
        service_id: service.id,
        status: result.response.status,
        duration_ms: elapsedMs(startedAt),
      });
      if (isHealthFailureStatus(result.response.status)) {
        await scheduleHealthUpdate(
          context,
          recordServiceFailure(env, service.id, requestId, "catalog"),
        );
      }
      return { service, success: false, models: [] };
    }
    const models = parseUpstreamModels(result.body);
    if (!models) {
      logWarn("models.upstream.invalid_response", {
        request_id: requestId,
        service_id: service.id,
        status: result.response.status,
        duration_ms: elapsedMs(startedAt),
      });
      await scheduleHealthUpdate(
        context,
        recordServiceFailure(env, service.id, requestId, "catalog"),
      );
      return { service, success: false, models: [] };
    }
    const filteredModels = models.filter((model) => {
      if (model.id === config.codex_auto_review.model) {
        return serviceSupportsAutoReview(service, model.id);
      }
      return service.models.includes(model.id);
    });
    logInfo("models.upstream.succeeded", {
      request_id: requestId,
      service_id: service.id,
      status: result.response.status,
      upstream_model_count: models.length,
      configured_model_count: filteredModels.length,
      duration_ms: elapsedMs(startedAt),
    });
    await scheduleHealthUpdate(
      context,
      recordServiceSuccess(env, service.id, requestId, "catalog"),
    );
    return {
      service,
      success: true,
      models: filteredModels,
    };
  } catch (error) {
    logWarn("models.upstream.exception", {
      request_id: requestId,
      service_id: service.id,
      error: errorMessage(error),
      duration_ms: elapsedMs(startedAt),
    });
    await scheduleHealthUpdate(
      context,
      recordServiceFailure(env, service.id, requestId, "catalog"),
    );
    return { service, success: false, models: [] };
  }
}

function standardModel(raw: JsonObject, id: string): JsonObject {
  return {
    ...raw,
    id,
    object: typeof raw.object === "string" ? raw.object : "model",
  };
}

function exposedClientModels(
  service: ServiceConfig,
  upstreamModel: string,
  aliases: Record<string, string>,
): string[] {
  const ids = service.models.includes(upstreamModel) ? [upstreamModel] : [];
  for (const [clientModel, target] of Object.entries(aliases)) {
    if (target === upstreamModel && service.models.includes(upstreamModel)) {
      ids.push(clientModel);
    }
  }
  return [...new Set(ids)];
}

export function aggregateStandardModels(
  results: ServiceModelsResult[],
  aliases: Record<string, string>,
): JsonObject[] {
  const merged = new Map<string, JsonObject>();

  for (const result of results) {
    if (!result.success) {
      continue;
    }
    for (const model of result.models) {
      const clientModels = exposedClientModels(result.service, model.id, aliases);
      for (const clientModel of clientModels) {
        if (clientModel === "codex-auto-review") {
          continue;
        }
        if (!merged.has(clientModel)) {
          merged.set(clientModel, standardModel(model.raw, clientModel));
        }
      }
    }
  }
  return [...merged.values()];
}

function codexModelIds(
  standardModels: JsonObject[],
  results: ServiceModelsResult[],
  config: GatewayConfig,
): Set<string> {
  const ids = new Set(
    standardModels
      .map((model) => model.id)
      .filter((id): id is string => typeof id === "string"),
  );
  const reviewAvailable = results.some(
    (result) =>
      result.success &&
      result.service.id === config.codex_auto_review.service &&
      result.models.some(
        (model) =>
          model.id === config.codex_auto_review.model &&
          serviceSupportsAutoReview(result.service, model.id),
      ),
  );
  if (reviewAvailable) {
    ids.add("codex-auto-review");
  }
  return ids;
}

export function aggregateCodexModels(clientModelIds: Set<string>): JsonObject[] {
  const catalog = codexCatalog as { models: JsonObject[] };
  return catalog.models.filter(
    (model) => typeof model.slug === "string" && clientModelIds.has(model.slug),
  );
}

export function isCodexUserAgent(request: Request): boolean {
  return request.headers.get("user-agent")?.toLowerCase().includes("codex") ?? false;
}

function cacheTtlMs(env: Env): number {
  const raw = env.MODELS_CACHE_TTL_SECONDS;
  const rawText = typeof raw === "string" ? raw.trim() : raw;
  const configured = rawText === undefined || rawText === ""
    ? DEFAULT_MODELS_CACHE_TTL_SECONDS
    : Number(rawText);
  if (!Number.isFinite(configured) || configured < 0) {
    return DEFAULT_MODELS_CACHE_TTL_SECONDS * 1000;
  }
  return Math.min(configured, MAX_MODELS_CACHE_TTL_SECONDS) * 1000;
}

function fallbackHash(value: string): string {
  let first = 2_166_136_261;
  let second = 3_339_675_911;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 16_777_619);
    second = Math.imul(second ^ code, 2_246_822_519);
  }
  const firstHex = (first >>> 0).toString(16).padStart(8, "0");
  const secondHex = (second >>> 0).toString(16).padStart(8, "0");
  return `${firstHex}${secondHex}`;
}

async function hashText(value: string): Promise<string> {
  try {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value),
    );
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return fallbackHash(value);
  }
}

function requestHeaderVary(request: Request): string {
  const entries: string[] = [];
  request.headers.forEach((value, name) => {
    if (!shouldStripRequestHeader(name)) {
      entries.push(`${name.toLowerCase()}:${value}`);
    }
  });
  return entries.sort().join("\n");
}

async function modelsCacheKey(
  request: Request,
  config: GatewayConfig,
  client: ClientApiKeyConfig,
  codexFormat: boolean,
): Promise<string> {
  const url = new URL(request.url);
  const serviceIds = [...client.services].sort().join(",");
  const vary = [
    JSON.stringify(config) ?? "",
    codexFormat ? "codex" : "standard",
    url.pathname === "/models" || url.pathname === "/v1/models" ? "models" : url.pathname,
    url.search,
    serviceIds,
    requestHeaderVary(request),
  ].join("\u0000");
  return hashText(vary);
}

function readModelsCache(key: string, now = Date.now()): JsonObject | undefined {
  const entry = modelsCache.get(key);
  if (!entry) {
    return undefined;
  }
  if (entry.expiresAt <= now) {
    modelsCache.delete(key);
    return undefined;
  }
  return entry.payload;
}

function writeModelsCache(key: string, payload: JsonObject, ttlMs: number): void {
  if (ttlMs <= 0) {
    return;
  }
  const now = Date.now();
  for (const [entryKey, entry] of modelsCache) {
    if (entry.expiresAt <= now) {
      modelsCache.delete(entryKey);
    }
  }
  if (modelsCache.size >= 128) {
    const oldestKey = modelsCache.keys().next().value;
    if (typeof oldestKey === "string") {
      modelsCache.delete(oldestKey);
    }
  }
  modelsCache.set(key, { expiresAt: now + ttlMs, payload });
}

export function clearModelsCacheForTests(): void {
  modelsCache.clear();
  modelsInFlight.clear();
}

function modelCount(payload: JsonObject, codexFormat: boolean): number {
  const models = payload[codexFormat ? "models" : "data"];
  return Array.isArray(models) ? models.length : 0;
}

async function mapWithConcurrency<T, Result>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<Result>,
): Promise<Result[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new RangeError("concurrency must be a positive safe integer");
  }
  const results = new Array<Result>(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) {
          return;
        }
        results[index] = await mapper(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function collectModels(
  request: Request,
  env: Env,
  config: GatewayConfig,
  configuredServices: ServiceConfig[],
  codexFormat: boolean,
  requestId: string,
  context?: HealthExecutionContext,
): Promise<JsonObject> {
  const health = await mapWithConcurrency(
    configuredServices,
    MODEL_CATALOG_CONCURRENCY,
    async (service) => ({
      service,
      available: await serviceIsAvailable(env, service.id, requestId, "catalog"),
    }),
  );
  const available = health.filter((entry) => entry.available).map((entry) => entry.service);
  if (available.length === 0) {
    logWarn("models.request.no_available_service", {
      request_id: requestId,
      configured_service_count: configuredServices.length,
    });
    throw new ModelsRequestError(
      503,
      "No healthy service is currently available",
      "server_error",
      "service_cooling_down",
    );
  }

  const results = await mapWithConcurrency(
    available,
    MODEL_CATALOG_CONCURRENCY,
    (service) => fetchServiceModels(request, env, config, service, requestId, context),
  );
  if (!results.some((result) => result.success)) {
    logWarn("models.request.no_upstream_catalog", {
      request_id: requestId,
      attempted_service_count: available.length,
    });
    throw new ModelsRequestError(
      502,
      "No upstream model catalog could be retrieved",
      "server_error",
      "upstream_unavailable",
    );
  }

  const standardModels = aggregateStandardModels(results, config.model_aliases);
  if (!codexFormat) {
    return { object: "list", data: standardModels };
  }
  const ids = codexModelIds(standardModels, results, config);
  return { models: aggregateCodexModels(ids) };
}

export async function handleModels(
  request: Request,
  env: Env,
  config: GatewayConfig,
  client: ClientApiKeyConfig,
  requestId = "unknown",
  context?: HealthExecutionContext,
): Promise<Response> {
  const configuredServices = allowedServices(config, client);
  registerSensitiveValues([
    ...configuredServices.map((service) => service.api_key),
    client.api_key,
  ]);
  const codexFormat = isCodexUserAgent(request);
  const ttlMs = cacheTtlMs(env);
  logInfo("models.request.started", {
    request_id: requestId,
    codex_format: codexFormat,
    configured_service_count: configuredServices.length,
    cache_enabled: ttlMs > 0,
  });
  const cacheKey = await modelsCacheKey(request, config, client, codexFormat);

  const cachedPayload = ttlMs > 0 ? readModelsCache(cacheKey) : undefined;
  if (cachedPayload) {
    logInfo("models.cache.hit", {
      request_id: requestId,
      response_format: codexFormat ? "codex" : "standard",
      returned_model_count: modelCount(cachedPayload, codexFormat),
    });
    logInfo("models.request.completed", {
      request_id: requestId,
      response_format: codexFormat ? "codex" : "standard",
      returned_model_count: modelCount(cachedPayload, codexFormat),
      cache_hit: true,
    });
    return jsonResponse(cachedPayload);
  }

  let collection = modelsInFlight.get(cacheKey);
  if (!collection) {
    collection = collectModels(
      request,
      env,
      config,
      configuredServices,
      codexFormat,
      requestId,
      context,
    );
    modelsInFlight.set(cacheKey, collection);
  } else {
    logInfo("models.cache.in_flight", { request_id: requestId });
  }

  try {
    const payload = await collection;
    writeModelsCache(cacheKey, payload, ttlMs);
    logInfo("models.request.completed", {
      request_id: requestId,
      response_format: codexFormat ? "codex" : "standard",
      returned_model_count: modelCount(payload, codexFormat),
      cache_hit: false,
    });
    return jsonResponse(payload);
  } catch (error) {
    if (error instanceof ModelsRequestError) {
      return openAiError(error.status, error.messageText, error.type, error.code);
    }
    throw error;
  } finally {
    if (modelsInFlight.get(cacheKey) === collection) {
      modelsInFlight.delete(cacheKey);
    }
  }
}
