import { discardBody, readBodyWithinLimit } from "./body.ts";
import {
  mapWithConcurrency,
  SERVICE_FAN_OUT_CONCURRENCY,
} from "./concurrency.ts";
import { upstreamApiKeyValues } from "./credentials.ts";
import {
  isHealthFailureStatus,
  isKeyHealthFailureStatus,
  recordKeyFailure,
  recordServiceFailure,
  recordServiceSuccess,
  scheduleHealthUpdate,
  type HealthExecutionContext,
} from "./health.ts";
import {
  forwardRequestHeaders,
  jsonResponse,
  openAiError,
  shouldStripRequestHeader,
  upstreamUrl,
} from "./http.ts";
import {
  elapsedMs,
  errorMessage,
  type LogFields,
  type RequestLogContext,
} from "./log.ts";
import codexCatalog from "./models.json" with { type: "json" };
import {
  allowedServiceCandidates,
  modelRoutesForClient,
  selectAvailableCatalogTargetsWithDetails,
  type RoutedService,
  type ServiceTarget,
} from "./routing.ts";
import type {
  ClientApiKeyConfig,
  GatewayConfig,
  ModelRouteConfig,
  ServiceConfig,
} from "./types.ts";
import {
  hasJsonUpstreamError,
  upstreamErrorStatusFields,
  upstreamResponseLogFields,
} from "./upstream-log.ts";

export const MODEL_CATALOG_TIMEOUT_MS = 3_000;
export const MAX_MODEL_CATALOG_BODY_BYTES = 8 * 1024 * 1024;
export const MODEL_CATALOG_CONCURRENCY = SERVICE_FAN_OUT_CONCURRENCY;
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
  upstream?: LogFields;
  upstreamError?: Promise<LogFields>;
}

interface ModelsCacheEntry {
  expiresAt: number;
  payload: JsonObject;
}

interface ModelsCollectionResult {
  payload: JsonObject;
  partialSuccess: boolean;
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

const modelsCache = new Map<string, ModelsCacheEntry>();

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
  target: ServiceTarget,
  requestId: string,
  context?: HealthExecutionContext,
  requestLog?: RequestLogContext,
): Promise<ServiceModelsResult> {
  const { service, key } = target;
  const incomingUrl = new URL(request.url);
  const headers = forwardRequestHeaders(request, key.api_key);
  const startedAt = performance.now();

  try {
    const result = await fetchCatalogResponse(
      upstreamUrl(service, "models", incomingUrl.search),
      {
        method: "GET",
        headers,
        redirect: "manual",
      },
    );
    const durationMs = elapsedMs(startedAt);
    if (!result.response.ok) {
      const upstream = {
        service_id: service.id,
        key_id: key.id,
        outcome: "http_error",
        duration_ms: durationMs,
        ...upstreamErrorStatusFields(result.response),
      };
      const upstreamError = requestLog && hasJsonUpstreamError(result.response)
        ? upstreamResponseLogFields(result.response, false)
        : undefined;
      if (!upstreamError) {
        await discardBody(result.response.body);
      }
      if (isHealthFailureStatus(result.response.status)) {
        await scheduleHealthUpdate(
          context,
          recordServiceFailure(env, service.id, requestId, "catalog"),
        );
      }
      if (isKeyHealthFailureStatus(result.response.status)) {
        await scheduleHealthUpdate(
          context,
          recordKeyFailure(env, service.id, key.id, requestId, "catalog"),
        );
      }
      return {
        service,
        success: false,
        models: [],
        upstream,
        upstreamError,
      };
    }
    const models = parseUpstreamModels(result.body);
    if (!models) {
      const upstream = {
        service_id: service.id,
        key_id: key.id,
        outcome: "invalid_response",
        duration_ms: durationMs,
        ...upstreamErrorStatusFields(result.response),
      };
      await scheduleHealthUpdate(
        context,
        recordServiceFailure(env, service.id, requestId, "catalog"),
      );
      return { service, success: false, models: [], upstream };
    }
    const filteredModels = models.filter((model) => service.models.includes(model.id));
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
    const upstream = {
      service_id: service.id,
      key_id: key.id,
      outcome: "exception",
      error: errorMessage(error),
      duration_ms: elapsedMs(startedAt),
    };
    await scheduleHealthUpdate(
      context,
      recordServiceFailure(env, service.id, requestId, "catalog"),
    );
    return { service, success: false, models: [], upstream };
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
  routes: Record<string, ModelRouteConfig>,
): string[] {
  if (!service.models.includes(upstreamModel)) {
    return [];
  }
  const ids = Object.hasOwn(routes, upstreamModel) ? [] : [upstreamModel];
  for (const [clientModel, route] of Object.entries(routes)) {
    if (
      route.model === upstreamModel &&
      (route.services === undefined || route.services.includes(service.id))
    ) {
      ids.push(clientModel);
    }
  }
  return [...new Set(ids)];
}

export function aggregateStandardModels(
  results: ServiceModelsResult[],
  routes: Record<string, ModelRouteConfig>,
): JsonObject[] {
  const merged = new Map<string, JsonObject>();

  for (const result of results) {
    if (!result.success) {
      continue;
    }
    for (const model of result.models) {
      const clientModels = exposedClientModels(result.service, model.id, routes);
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
  routes: Record<string, ModelRouteConfig>,
): Set<string> {
  const ids = new Set(
    standardModels
      .map((model) => model.id)
      .filter((id): id is string => typeof id === "string"),
  );
  for (const result of results) {
    if (!result.success) {
      continue;
    }
    for (const model of result.models) {
      for (const clientModel of exposedClientModels(result.service, model.id, routes)) {
        ids.add(clientModel);
      }
    }
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

async function hashText(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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
    JSON.stringify(config),
    codexFormat ? "codex" : "standard",
    url.pathname === "/models" || url.pathname === "/v1/models" ? "models" : url.pathname,
    url.search,
    serviceIds,
    client.id,
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
}

async function collectModels(
  request: Request,
  env: Env,
  config: GatewayConfig,
  client: ClientApiKeyConfig,
  configuredTargets: RoutedService[],
  codexFormat: boolean,
  requestId: string,
  context?: HealthExecutionContext,
  requestLog?: RequestLogContext,
): Promise<ModelsCollectionResult> {
  const selection = await selectAvailableCatalogTargetsWithDetails(
    env,
    configuredTargets,
  );
  const available = selection.targets;
  const routing = {
    checked_available_services: available.map((entry) => entry.service.id),
    selected_keys: available.map(({ service, key }) => ({
      service_id: service.id,
      key_id: key.id,
    })),
    service_checks: selection.checks,
    key_checks: selection.keyChecks,
  };
  requestLog?.mergeSection("routing", routing);
  if (
    selection.checks.some((entry) => entry.reason === "health_read_failed") ||
    selection.keyChecks.some((entry) => entry.reason === "health_read_failed")
  ) {
    requestLog?.warn();
  }
  if (available.length === 0) {
    requestLog?.warn({ outcome: "service_cooling_down" });
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
    (target) => fetchServiceModels(
      request,
      env,
      target,
      requestId,
      context,
      requestLog,
    ),
  );
  const upstreamErrors = results.flatMap((result) =>
    !result.success && result.upstream ? [result.upstream] : []
  );
  if (upstreamErrors.length > 0) {
    requestLog?.mergeSection("catalog", { upstream_errors: upstreamErrors });
  }
  if (requestLog && results.some((result) => result.upstreamError)) {
    requestLog.defer((async () => {
      for (const result of results) {
        if (result.upstream && result.upstreamError) {
          const fields = await result.upstreamError;
          Object.assign(
            result.upstream,
            requestLog.limitUpstreamErrorFields(fields),
          );
        }
      }
    })());
  }
  if (!results.some((result) => result.success)) {
    requestLog?.warn({ outcome: "upstream_unavailable" });
    throw new ModelsRequestError(
      502,
      "No upstream model catalog could be retrieved",
      "server_error",
      "upstream_unavailable",
    );
  }

  const modelRoutes = modelRoutesForClient(config, client);
  const standardModels = aggregateStandardModels(results, modelRoutes);
  const payload = !codexFormat
    ? { object: "list", data: standardModels }
    : {
      models: aggregateCodexModels(
        codexModelIds(standardModels, results, modelRoutes),
      ),
    };
  return {
    payload,
    partialSuccess: upstreamErrors.length > 0,
  };
}

export async function handleModels(
  request: Request,
  env: Env,
  config: GatewayConfig,
  client: ClientApiKeyConfig,
  requestId = "unknown",
  context?: HealthExecutionContext,
  requestLog?: RequestLogContext,
): Promise<Response> {
  const configuredTargets = allowedServiceCandidates(config, client);
  requestLog?.registerSensitiveValues([
    client.api_key,
    ...upstreamApiKeyValues(config),
  ]);
  const codexFormat = isCodexUserAgent(request);
  const ttlMs = cacheTtlMs(env);
  requestLog?.set({
    routing: {
      candidate_services: configuredTargets.map(({ service }) => service.id),
    },
  });
  requestLog?.mergeSection("catalog", {
    response_format: codexFormat ? "codex" : "standard",
    cache_enabled: ttlMs > 0,
  });
  const cacheKey = await modelsCacheKey(request, config, client, codexFormat);

  const cachedPayload = ttlMs > 0 ? readModelsCache(cacheKey) : undefined;
  if (cachedPayload) {
    requestLog?.mergeSection("catalog", { cache: "hit" });
    return jsonResponse(cachedPayload);
  }

  requestLog?.mergeSection("catalog", { cache: "miss" });

  try {
    const result = await collectModels(
      request,
      env,
      config,
      client,
      configuredTargets,
      codexFormat,
      requestId,
      context,
      requestLog,
    );
    if (result.partialSuccess) {
      requestLog?.warn({ outcome: "partial_success" });
    }
    writeModelsCache(cacheKey, result.payload, ttlMs);
    return jsonResponse(result.payload);
  } catch (error) {
    if (error instanceof ModelsRequestError) {
      requestLog?.warn({
        outcome: error.code,
        error: error.messageText,
      });
      return openAiError(error.status, error.messageText, error.type, error.code);
    }
    throw error;
  }
}
