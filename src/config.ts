import type {
  ClientApiKeyConfig,
  CodexAutoReviewConfig,
  GatewayConfig,
  ServiceConfig,
  ServiceRetryConfig,
} from "./types.ts";
import { errorMessage, logError, logInfo, logWarn } from "./log.ts";

const DEFAULT_CONFIG_KEY = "gateway-config";
const DEFAULT_CACHE_TTL_SECONDS = 10;
const MAX_RETRY_STATUS_CODES = 20;
const MAX_RETRY_DELAYS = 10;
const MAX_RETRY_DELAY_MS = 60_000;
const ROOT_FIELDS = new Set([
  "$schema",
  "services",
  "api_keys",
  "model_aliases",
  "codex_auto_review",
]);
const SERVICE_FIELDS = new Set([
  "id",
  "base_url",
  "api_key",
  "disabled",
  "priority",
  "models",
  "retry",
]);
const API_KEY_FIELDS = new Set(["api_key", "services"]);
const AUTO_REVIEW_FIELDS = new Set(["service", "model"]);
const RETRY_FIELDS = new Set(["status_codes", "delays_ms"]);

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

let cached: { config: GatewayConfig; expiresAt: number } | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ConfigError(`${path}.${key} is not supported`);
    }
  }
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`${path} must be a non-empty string`);
  }
  return value.trim();
}

function requiredInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ConfigError(`${path} must be an integer`);
  }
  return value;
}

function requiredBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new ConfigError(`${path} must be a boolean`);
  }
  return value;
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ConfigError(`${path} must be a non-empty array`);
  }
  const result = value.map((entry, index) => requiredString(entry, `${path}[${index}]`));
  if (new Set(result).size !== result.length) {
    throw new ConfigError(`${path} must not contain duplicates`);
  }
  return result;
}

function integerArray(
  value: unknown,
  path: string,
  options: {
    maxItems: number;
    minValue: number;
    maxValue: number;
    unique?: boolean;
  },
): number[] {
  if (!Array.isArray(value)) {
    throw new ConfigError(`${path} must be an array`);
  }
  if (value.length > options.maxItems) {
    throw new ConfigError(`${path} must contain at most ${options.maxItems} items`);
  }
  const result = value.map((entry, index) => {
    const itemPath = `${path}[${index}]`;
    const parsed = requiredInteger(entry, itemPath);
    if (parsed < options.minValue || parsed > options.maxValue) {
      throw new ConfigError(
        `${itemPath} must be between ${options.minValue} and ${options.maxValue}`,
      );
    }
    return parsed;
  });
  if (options.unique && new Set(result).size !== result.length) {
    throw new ConfigError(`${path} must not contain duplicates`);
  }
  return result;
}

function parseRetry(value: unknown, path: string): ServiceRetryConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new ConfigError(`${path} must be an object`);
  }
  rejectUnknownFields(value, RETRY_FIELDS, path);
  const statusCodes = integerArray(value.status_codes, `${path}.status_codes`, {
    maxItems: MAX_RETRY_STATUS_CODES,
    minValue: 400,
    maxValue: 599,
    unique: true,
  });
  const delaysMs = integerArray(value.delays_ms, `${path}.delays_ms`, {
    maxItems: MAX_RETRY_DELAYS,
    minValue: 0,
    maxValue: MAX_RETRY_DELAY_MS,
  });
  if ((statusCodes.length === 0) !== (delaysMs.length === 0)) {
    throw new ConfigError(
      `${path}.status_codes and ${path}.delays_ms must both be empty or both be non-empty`,
    );
  }
  return { status_codes: statusCodes, delays_ms: delaysMs };
}

function validateBaseUrl(value: string, path: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${path} must be an absolute http(s) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`${path} must use http or https`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ConfigError(`${path} must not contain credentials, query parameters, or a fragment`);
  }
  return value.replace(/\/+$/, "");
}

function parseService(value: unknown, index: number): ServiceConfig {
  const path = `services[${index}]`;
  if (!isRecord(value)) {
    throw new ConfigError(`${path} must be an object`);
  }
  rejectUnknownFields(value, SERVICE_FIELDS, path);
  const id = requiredString(value.id, `${path}.id`);
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new ConfigError(`${path}.id contains unsupported characters`);
  }
  const retry = parseRetry(value.retry, `${path}.retry`);
  return {
    id,
    base_url: validateBaseUrl(requiredString(value.base_url, `${path}.base_url`), `${path}.base_url`),
    api_key: requiredString(value.api_key, `${path}.api_key`),
    disabled: requiredBoolean(value.disabled, `${path}.disabled`),
    priority: requiredInteger(value.priority, `${path}.priority`),
    models: stringArray(value.models, `${path}.models`),
    ...(retry === undefined ? {} : { retry }),
  };
}

function parseApiKey(value: unknown, index: number): ClientApiKeyConfig {
  const path = `api_keys[${index}]`;
  if (!isRecord(value)) {
    throw new ConfigError(`${path} must be an object`);
  }
  rejectUnknownFields(value, API_KEY_FIELDS, path);
  return {
    api_key: requiredString(value.api_key, `${path}.api_key`),
    services: stringArray(value.services, `${path}.services`),
  };
}

function parseAliases(value: unknown): Record<string, string> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new ConfigError("model_aliases must be an object");
  }
  const aliases: Record<string, string> = {};
  for (const [clientModel, upstreamModel] of Object.entries(value)) {
    const client = requiredString(clientModel, "model_aliases key");
    const upstream = requiredString(upstreamModel, `model_aliases.${client}`);
    if (client === "codex-auto-review") {
      throw new ConfigError("model_aliases must not override codex-auto-review");
    }
    if (client === upstream) {
      throw new ConfigError(`model_aliases.${client} must map to a different model`);
    }
    aliases[client] = upstream;
  }
  return aliases;
}

function parseAutoReview(value: unknown): CodexAutoReviewConfig {
  if (!isRecord(value)) {
    throw new ConfigError("codex_auto_review must be an object");
  }
  rejectUnknownFields(value, AUTO_REVIEW_FIELDS, "codex_auto_review");
  return {
    service: requiredString(value.service, "codex_auto_review.service"),
    model: requiredString(value.model, "codex_auto_review.model"),
  };
}

export function parseConfig(value: unknown): GatewayConfig {
  if (!isRecord(value)) {
    throw new ConfigError("configuration must be a JSON object");
  }
  rejectUnknownFields(value, ROOT_FIELDS, "configuration");
  if (value.$schema !== undefined && typeof value.$schema !== "string") {
    throw new ConfigError("configuration.$schema must be a string");
  }
  if (!Array.isArray(value.services) || value.services.length === 0) {
    throw new ConfigError("services must be a non-empty array");
  }
  if (!Array.isArray(value.api_keys) || value.api_keys.length === 0) {
    throw new ConfigError("api_keys must be a non-empty array");
  }

  const services = value.services.map(parseService);
  const serviceIds = new Set(services.map((service) => service.id));
  if (serviceIds.size !== services.length) {
    throw new ConfigError("services.id values must be unique");
  }

  const apiKeys = value.api_keys.map(parseApiKey);
  if (new Set(apiKeys.map((entry) => entry.api_key)).size !== apiKeys.length) {
    throw new ConfigError("api_keys.api_key values must be unique");
  }
  for (const [index, entry] of apiKeys.entries()) {
    for (const serviceId of entry.services) {
      if (!serviceIds.has(serviceId)) {
        throw new ConfigError(`api_keys[${index}].services references unknown service ${serviceId}`);
      }
    }
  }

  const modelAliases = parseAliases(value.model_aliases);
  for (const service of services) {
    for (const model of service.models) {
      if (Object.hasOwn(modelAliases, model)) {
        throw new ConfigError(
          `services.${service.id}.models must contain upstream names, not alias ${model}`,
        );
      }
    }
  }
  const knownUpstreamModels = new Set(services.flatMap((service) => service.models));
  for (const [clientModel, upstreamModel] of Object.entries(modelAliases)) {
    if (Object.hasOwn(modelAliases, upstreamModel)) {
      throw new ConfigError(`model_aliases.${clientModel} must not target another alias`);
    }
    if (!knownUpstreamModels.has(upstreamModel)) {
      throw new ConfigError(
        `model_aliases.${clientModel} targets ${upstreamModel}, which no service supports`,
      );
    }
  }

  const codexAutoReview = parseAutoReview(value.codex_auto_review);
  const autoReviewService = services.find((service) => service.id === codexAutoReview.service);
  if (!autoReviewService) {
    throw new ConfigError(`codex_auto_review.service references unknown service ${codexAutoReview.service}`);
  }
  if (!autoReviewService.models.includes(codexAutoReview.model)) {
    throw new ConfigError(
      `codex_auto_review.model ${codexAutoReview.model} is not listed by its service`,
    );
  }

  return {
    services,
    api_keys: apiKeys,
    model_aliases: modelAliases,
    codex_auto_review: codexAutoReview,
  };
}

function cacheTtlMs(env: Env): number {
  const configured = Number(env.CONFIG_CACHE_TTL_SECONDS ?? DEFAULT_CACHE_TTL_SECONDS);
  if (!Number.isFinite(configured) || configured < 0) {
    return DEFAULT_CACHE_TTL_SECONDS * 1000;
  }
  return Math.min(configured, 300) * 1000;
}

export async function loadConfig(env: Env, requestId?: string): Promise<GatewayConfig> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.config;
  }

  try {
    const raw = await env.CODEX_NEWAPI_CONFIG_KV.get(
      env.CONFIG_KEY ?? DEFAULT_CONFIG_KEY,
    );
    if (!raw) {
      throw new ConfigError(
        "configuration key is missing from CODEX_NEWAPI_CONFIG_KV",
      );
    }
    const config = parseConfig(JSON.parse(raw) as unknown);
    const ttlMs = cacheTtlMs(env);
    cached = { config, expiresAt: now + ttlMs };
    logInfo("config.loaded", {
      request_id: requestId,
      service_count: config.services.length,
      client_key_count: config.api_keys.length,
      alias_count: Object.keys(config.model_aliases).length,
      cache_ttl_ms: ttlMs,
    });
    return config;
  } catch (error) {
    if (cached) {
      cached.expiresAt = now + 5000;
      logWarn("config.load.failed_using_cache", {
        request_id: requestId,
        error: errorMessage(error),
      });
      return cached.config;
    }
    logError("config.load.failed", {
      request_id: requestId,
      error: errorMessage(error),
    });
    if (error instanceof ConfigError) {
      throw error;
    }
    throw new ConfigError(`configuration could not be loaded: ${String(error)}`);
  }
}

export function clearConfigCacheForTests(): void {
  cached = undefined;
}
