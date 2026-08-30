import { discardBody, readBodyWithinLimit } from "./body.ts";
import {
  mapWithConcurrency,
  SERVICE_FAN_OUT_CONCURRENCY,
} from "./concurrency.ts";
import { upstreamApiKeyValues } from "./credentials.ts";
import {
  healthFailureScope,
  recordKeyFailure,
  recordServiceFailure,
  recordServiceSuccess,
  scheduleHealthUpdate,
  type HealthExecutionContext,
} from "./health.ts";
import {
  apiError,
  forwardRequestHeaders,
  jsonResponse,
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
import { requestProtocol } from "./protocol.ts";
import {
  allowedServiceCandidates,
  modelRoutesByService,
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

export type ModelsFormat = "openai" | "codex" | "anthropic";

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
  // Always present on a failed result, possibly undefined when the error body
  // was not JSON. Success results omit it.
  upstreamError?: Promise<LogFields> | undefined;
}

interface ModelsCacheEntry {
  expiresAt: number;
  payload: JsonObject;
}

class ModelsCache {
  private readonly entries = new Map<string, ModelsCacheEntry>();

  constructor(private readonly maxEntries = 128) {}

  read(key: string, now = Date.now()): JsonObject | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.payload;
  }

  write(
    key: string,
    payload: JsonObject,
    ttlMs: number,
    now = Date.now(),
  ): void {
    if (ttlMs <= 0) {
      return;
    }
    for (const [entryKey, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(entryKey);
      }
    }
    if (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (typeof oldestKey === "string") {
        this.entries.delete(oldestKey);
      }
    }
    this.entries.set(key, { expiresAt: now + ttlMs, payload });
  }

  clear(): void {
    this.entries.clear();
  }
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

const modelsCache = new ModelsCache();

// The Codex catalog does not publish release dates or per-model max output
// limits. Claude Code treats 32k as the default max_tokens for unknown
// models (refs/claude-code/src/utils/context.ts) and 200k as the fallback
// context window, so mirror those values for models outside the catalog.
const ANTHROPIC_MODEL_CREATED_AT = "2024-01-01T00:00:00Z";
const ANTHROPIC_MODEL_MAX_TOKENS = 32000;
const ANTHROPIC_MODEL_DEFAULT_CONTEXT_TOKENS = 200000;
// A model only advertises 1M context when its context window actually reaches
// 1M. The fallback above is 200k, so models outside the catalog report false.
const ANTHROPIC_1M_CONTEXT_TOKENS = 1_000_000;

const codexCatalogModels = (codexCatalog as { models: JsonObject[] }).models;
const codexModelBySlug = new Map<string, JsonObject>();
for (const model of codexCatalogModels) {
  if (typeof model.slug === "string") {
    codexModelBySlug.set(model.slug, model);
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseUpstreamModels(
  value: unknown,
): UpstreamModel[] | undefined {
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
    const id =
      typeof entry.id === "string"
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
  return new Error(
    `model catalog request timed out after ${MODEL_CATALOG_TIMEOUT_MS}ms`,
  );
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
  // /v1/models is dialect-neutral, so this resolves from the client's identity.
  // A service may serve either dialect, so it cannot declare one.
  const protocol = requestProtocol(request, "models");
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
      const upstreamError =
        requestLog && hasJsonUpstreamError(result.response)
          ? upstreamResponseLogFields(result.response, false)
          : undefined;
      if (!upstreamError) {
        await discardBody(result.response.body);
      }
      const failureScope = healthFailureScope(result.response.status, protocol);
      if (failureScope === "service") {
        await scheduleHealthUpdate(
          context,
          recordServiceFailure(env, service.id, requestId, "catalog"),
        );
      } else if (failureScope === "key") {
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
    const filteredModels = models.filter((model) =>
      service.models.includes(model.id),
    );
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
  routesByService: Map<string, Record<string, ModelRouteConfig>>,
): JsonObject[] {
  const merged = new Map<string, JsonObject>();

  for (const result of results) {
    if (!result.success) {
      continue;
    }
    for (const model of result.models) {
      const clientModels = exposedClientModels(
        result.service,
        model.id,
        routesByService.get(result.service.id) ?? {},
      );
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
  routesByService: Map<string, Record<string, ModelRouteConfig>>,
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
      for (const clientModel of exposedClientModels(
        result.service,
        model.id,
        routesByService.get(result.service.id) ?? {},
      )) {
        ids.add(clientModel);
      }
    }
  }
  return ids;
}

export function aggregateCodexModels(
  clientModelIds: Set<string>,
): JsonObject[] {
  return codexCatalogModels.filter(
    (model) => typeof model.slug === "string" && clientModelIds.has(model.slug),
  );
}

export function isCodexUserAgent(request: Request): boolean {
  return (
    request.headers.get("user-agent")?.toLowerCase().includes("codex") ?? false
  );
}

export function modelsFormatFor(request: Request): ModelsFormat {
  // `models` is dialect-neutral, so requestProtocol resolves it from the
  // client's own identity. The Claude user-agent rule lives there, not here.
  if (requestProtocol(request, "models") === "anthropic") {
    return "anthropic";
  }
  return isCodexUserAgent(request) ? "codex" : "openai";
}

/**
 * True when the upstream already returned an Anthropic `ModelInfo`, which a real
 * Anthropic-compatible `/v1/models` does. Its own fields beat anything the
 * gateway could derive from the Codex catalog.
 */
function isAnthropicModelInfo(model: JsonObject): boolean {
  return model.type === "model" && isObject(model.capabilities);
}

function anthropicModelInfo(model: JsonObject): JsonObject {
  const id = typeof model.id === "string" ? model.id : "";
  if (isAnthropicModelInfo(model)) {
    // api.anthropic.com does not send `name`, so add it without overwriting a
    // value the upstream did provide. Claude Desktop Discovery needs it.
    return { name: id, ...model, id };
  }
  const catalog = codexModelBySlug.get(id);
  const inputModalities = Array.isArray(catalog?.input_modalities)
    ? (catalog.input_modalities as unknown[])
    : [];
  const supportsImages = inputModalities.includes("image");
  const supportsPdf = inputModalities.includes("pdf");
  const supportsCodeExecution =
    catalog !== undefined &&
    typeof catalog.node_repl_disabled === "boolean" &&
    !catalog.node_repl_disabled;
  const supportedEffortLevels = Array.isArray(
    catalog?.supported_reasoning_levels,
  )
    ? (catalog.supported_reasoning_levels as unknown[])
        .filter(
          (entry): entry is { effort?: unknown } =>
            typeof entry === "object" && entry !== null,
        )
        .map((entry) => entry.effort)
        .filter((effort): effort is string => typeof effort === "string")
    : [];
  const supportsEffort = supportedEffortLevels.length > 0;
  const maxInputTokens =
    typeof catalog?.max_context_window === "number"
      ? catalog.max_context_window
      : ANTHROPIC_MODEL_DEFAULT_CONTEXT_TOKENS;

  const supports1mContext = maxInputTokens >= ANTHROPIC_1M_CONTEXT_TOKENS;

  const displayName =
    typeof catalog?.display_name === "string" ? catalog.display_name : id;
  const effortCapability = {
    supported: supportsEffort,
    low: { supported: supportedEffortLevels.includes("low") },
    medium: { supported: supportedEffortLevels.includes("medium") },
    high: { supported: supportedEffortLevels.includes("high") },
    max: { supported: supportedEffortLevels.includes("max") },
    xhigh: { supported: supportedEffortLevels.includes("xhigh") },
  };

  return {
    id,
    // Fields the API reference does not list, because they serve the clients
    // rather than api.anthropic.com: Claude Desktop Discovery requires `name`,
    // and Claude Code reads the 1M flags to offer that context window.
    name: id,
    type: "model",
    display_name: displayName,
    supports1m: supports1mContext,
    prefer1m: supports1mContext,
    created_at: ANTHROPIC_MODEL_CREATED_AT,
    max_input_tokens: maxInputTokens,
    // The catalog publishes no output-token field for any model, so this is the
    // Claude Code default for unknown models rather than a per-model limit.
    max_tokens: ANTHROPIC_MODEL_MAX_TOKENS,
    capabilities: {
      // The Codex catalog has no per-model equivalent for these two, and the
      // gateway cannot probe an upstream for them, so they report the protocol
      // default rather than a verified per-model value.
      batch: { supported: true },
      citations: { supported: true },
      code_execution: { supported: supportsCodeExecution },
      // Three named Anthropic beta strategies with nothing equivalent in the
      // Codex catalog. Reasoning-summary support says nothing about them, so
      // they report unsupported instead of guessing from an unrelated signal.
      context_management: {
        supported: false,
        clear_thinking_20251015: { supported: false },
        clear_tool_uses_20250919: { supported: false },
        compact_20260112: { supported: false },
      },
      effort: effortCapability,
      image_input: { supported: supportsImages },
      pdf_input: { supported: supportsPdf },
      // Protocol default, as with batch and citations above.
      structured_outputs: { supported: true },
      thinking: {
        supported: supportsEffort,
        types: {
          adaptive: { supported: supportsEffort },
          enabled: { supported: supportsEffort },
        },
      },
    },
  };
}

function cacheTtlMs(env: Env): number {
  const raw = env.MODELS_CACHE_TTL_SECONDS;
  const rawText = typeof raw === "string" ? raw.trim() : raw;
  const configured =
    rawText === undefined || rawText === ""
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
  format: ModelsFormat,
): Promise<string> {
  const url = new URL(request.url);
  const serviceIds = [...client.services].sort().join(",");
  const vary = [
    JSON.stringify(config),
    format,
    url.pathname === "/models" || url.pathname === "/v1/models"
      ? "models"
      : url.pathname,
    url.search,
    serviceIds,
    client.id,
    requestHeaderVary(request),
  ].join("\u0000");
  return hashText(vary);
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
  format: ModelsFormat,
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
    (target) =>
      fetchServiceModels(request, env, target, requestId, context, requestLog),
  );
  const upstreamErrors = results.flatMap((result) =>
    !result.success && result.upstream ? [result.upstream] : [],
  );
  if (upstreamErrors.length > 0) {
    requestLog?.mergeSection("catalog", { upstream_errors: upstreamErrors });
  }
  if (requestLog && results.some((result) => result.upstreamError)) {
    requestLog.defer(
      (async () => {
        for (const result of results) {
          if (result.upstream && result.upstreamError) {
            const fields = await result.upstreamError;
            Object.assign(
              result.upstream,
              requestLog.limitUpstreamErrorFields(fields),
            );
          }
        }
      })(),
    );
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

  const routesByService = modelRoutesByService(config, client);
  const standardModels = aggregateStandardModels(results, routesByService);
  const payload = modelsPayload(
    standardModels,
    results,
    routesByService,
    format,
  );
  return {
    payload,
    partialSuccess: upstreamErrors.length > 0,
  };
}

function modelsPayload(
  standardModels: JsonObject[],
  results: ServiceModelsResult[],
  routesByService: Map<string, Record<string, ModelRouteConfig>>,
  format: ModelsFormat,
): JsonObject {
  switch (format) {
    case "codex":
      return {
        models: aggregateCodexModels(
          codexModelIds(standardModels, results, routesByService),
        ),
      };
    case "anthropic": {
      const data = standardModels.map(anthropicModelInfo);
      return {
        data,
        has_more: false,
        first_id: data[0]?.id ?? null,
        last_id: data.at(-1)?.id ?? null,
      };
    }
    case "openai":
      return { object: "list", data: standardModels };
  }
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
  const format = modelsFormatFor(request);
  const ttlMs = cacheTtlMs(env);
  requestLog?.set({
    routing: {
      candidate_services: configuredTargets.map(({ service }) => service.id),
    },
  });
  requestLog?.mergeSection("catalog", {
    response_format: format,
    cache_enabled: ttlMs > 0,
  });
  const cacheKey = await modelsCacheKey(request, config, client, format);

  const cachedPayload = ttlMs > 0 ? modelsCache.read(cacheKey) : undefined;
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
      format,
      requestId,
      context,
      requestLog,
    );
    if (result.partialSuccess) {
      requestLog?.warn({ outcome: "partial_success" });
    }
    modelsCache.write(cacheKey, result.payload, ttlMs);
    return jsonResponse(result.payload);
  } catch (error) {
    if (error instanceof ModelsRequestError) {
      requestLog?.warn({
        outcome: error.code,
        error: error.messageText,
      });
      return apiError(
        requestProtocol(request),
        error.status,
        error.messageText,
        { type: error.type, code: error.code, requestId },
      );
    }
    throw error;
  }
}
