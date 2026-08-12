import { isRecord, nonBlankString } from "./search-providers/shared.ts";

export const MAX_SEARCH_QUERIES = 4;
export const MAX_RECENCY_DAYS = 3650;

const SUPPORTED_COMMANDS = new Set(["search_query", "response_length"]);
const SUPPORTED_SETTINGS = new Set([
  "filters",
  "allowed_callers",
  "external_web_access",
]);
const SUPPORTED_FILTERS = new Set(["allowed_domains", "blocked_domains"]);
const SUPPORTED_QUERY_FIELDS = new Set(["q", "recency", "domains"]);
const ALLOWED_CALLERS = new Set(["direct", "shell", "code_interpreter"]);
const RESPONSE_LENGTHS = new Set(["short", "medium", "long"]);

export type SearchResponseLength = "short" | "medium" | "long";

export interface SearchQuery {
  q: string;
  recency?: number;
  domains?: string[];
}

export interface SearchFilters {
  allowedDomains?: string[];
  blockedDomains?: string[];
}

export interface ParsedSearchRequest {
  model: string;
  queries: SearchQuery[];
  filters: SearchFilters;
  responseLength?: SearchResponseLength;
}

export type SearchRequestErrorKind =
  | "invalid_search_request"
  | "unsupported_search_command"
  | "unsupported_search_setting";

export class SearchRequestError extends Error {
  constructor(
    message: string,
    readonly kind: SearchRequestErrorKind = "invalid_search_request",
  ) {
    super(message);
    this.name = "SearchRequestError";
  }
}

function fail(message: string): never {
  throw new SearchRequestError(message);
}

function unsupported(kind: Exclude<SearchRequestErrorKind, "invalid_search_request">, fields: string[]): never {
  throw new SearchRequestError(
    `Configured web search adapter does not support: ${fields.join(", ")}`,
    kind,
  );
}

function optionalDomains(
  value: unknown,
  path: string,
  options: { allowEmpty: boolean },
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) ||
    (!options.allowEmpty && value.length === 0) ||
    value.some((domain) => !nonBlankString(domain))) {
    fail(`${path} must be ${options.allowEmpty ? "an" : "a non-empty"} array of strings`);
  }
  return value.map((domain) => nonBlankString(domain) as string);
}

export function intersectDomains(
  queryDomains: string[] | undefined,
  allowedDomains: string[] | undefined,
): string[] | undefined {
  if (queryDomains === undefined) {
    return allowedDomains;
  }
  if (allowedDomains === undefined) {
    return queryDomains;
  }
  const allowed = new Set(allowedDomains.map((domain) => domain.toLowerCase()));
  const intersection = queryDomains.filter((domain) => allowed.has(domain.toLowerCase()));
  if (intersection.length === 0) {
    fail("query domains do not intersect settings.filters.allowed_domains");
  }
  return intersection;
}

function parseQueries(commands: Record<string, unknown> | undefined): SearchQuery[] {
  if (!commands || commands.search_query === undefined) {
    fail("commands.search_query is required by this web search adapter");
  }
  if (!Array.isArray(commands.search_query) || commands.search_query.length === 0) {
    fail("commands.search_query must be a non-empty array");
  }
  if (commands.search_query.length > MAX_SEARCH_QUERIES) {
    fail(`commands.search_query supports at most ${MAX_SEARCH_QUERIES} queries`);
  }
  return commands.search_query.map((entry, index) => {
    if (!isRecord(entry)) {
      fail(`commands.search_query[${index}] must be an object`);
    }
    const unsupportedFields = Object.keys(entry).filter((key) => !SUPPORTED_QUERY_FIELDS.has(key));
    if (unsupportedFields.length > 0) {
      unsupported(
        "unsupported_search_command",
        unsupportedFields.map((key) => `commands.search_query[${index}].${key}`),
      );
    }
    const q = nonBlankString(entry.q);
    if (!q) {
      fail(`commands.search_query[${index}].q must be a non-empty string`);
    }
    const recency = entry.recency;
    if (recency !== undefined &&
      (typeof recency !== "number" ||
        !Number.isSafeInteger(recency) ||
        recency < 0 ||
        recency > MAX_RECENCY_DAYS)) {
      fail(
        `commands.search_query[${index}].recency must be an integer between 0 and ${MAX_RECENCY_DAYS}`,
      );
    }
    const domains = entry.domains;
    if (domains !== undefined &&
      (!Array.isArray(domains) || domains.some((domain) => !nonBlankString(domain)))) {
      fail(`commands.search_query[${index}].domains must be an array of strings`);
    }
    return {
      q,
      ...(recency === undefined ? {} : { recency }),
      ...(domains === undefined ? {} : {
        domains: domains.map((domain) => nonBlankString(domain) as string),
      }),
    };
  });
}

function parseResponseLength(
  commands: Record<string, unknown> | undefined,
): SearchResponseLength | undefined {
  const value = commands?.response_length;
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !RESPONSE_LENGTHS.has(value)) {
    fail("commands.response_length must be short, medium, or long");
  }
  return value as SearchResponseLength;
}

function parseFilters(settings: Record<string, unknown> | undefined): SearchFilters {
  if (!settings || settings.filters === undefined) {
    return {};
  }
  if (!isRecord(settings.filters)) {
    fail("settings.filters must be a JSON object");
  }
  const filters = settings.filters;
  for (const key of Object.keys(filters)) {
    if (!SUPPORTED_FILTERS.has(key)) {
      unsupported("unsupported_search_setting", [`settings.filters.${key}`]);
    }
  }
  const allowedDomains = optionalDomains(
    filters.allowed_domains,
    "settings.filters.allowed_domains",
    { allowEmpty: false },
  );
  const blockedDomains = optionalDomains(
    filters.blocked_domains,
    "settings.filters.blocked_domains",
    { allowEmpty: true },
  );
  return {
    ...(allowedDomains === undefined ? {} : { allowedDomains }),
    ...(blockedDomains === undefined ? {} : { blockedDomains }),
  };
}

function validateSearchMetadata(settings: Record<string, unknown> | undefined): void {
  if (!settings) {
    return;
  }
  if (settings.allowed_callers !== undefined &&
    (!Array.isArray(settings.allowed_callers) ||
      settings.allowed_callers.length === 0 ||
      settings.allowed_callers.some(
        (caller) => typeof caller !== "string" || !ALLOWED_CALLERS.has(caller),
      ))) {
    fail(
      "settings.allowed_callers must be a non-empty array containing direct, shell, or code_interpreter",
    );
  }
  const externalWebAccess = settings.external_web_access;
  if (externalWebAccess !== undefined &&
    typeof externalWebAccess !== "boolean" &&
    externalWebAccess !== "cached" &&
    externalWebAccess !== "indexed" &&
    externalWebAccess !== "live") {
    fail("settings.external_web_access must be a boolean, cached, indexed, or live");
  }
}

function parsePayload(text: string): {
  model: string;
  commands?: Record<string, unknown>;
  settings?: Record<string, unknown>;
} {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    fail("request body must be valid JSON");
  }
  if (!isRecord(value)) {
    fail("request body must be a JSON object");
  }
  const model = nonBlankString(value.model);
  if (!model) {
    fail("request body must contain a non-empty model string");
  }
  if (value.commands !== undefined && !isRecord(value.commands)) {
    fail("commands must be a JSON object");
  }
  if (value.settings !== undefined && !isRecord(value.settings)) {
    fail("settings must be a JSON object");
  }
  return {
    model,
    ...(value.commands === undefined ? {} : { commands: value.commands }),
    ...(value.settings === undefined ? {} : { settings: value.settings }),
  };
}

export function parseSearchRequest(text: string): ParsedSearchRequest {
  const payload = parsePayload(text);
  if (payload.commands) {
    const unsupportedCommands = Object.keys(payload.commands).filter(
      (key) => !SUPPORTED_COMMANDS.has(key),
    );
    if (unsupportedCommands.length > 0) {
      unsupported("unsupported_search_command", unsupportedCommands);
    }
  }
  if (payload.settings) {
    const unsupportedSettings = Object.keys(payload.settings).filter(
      (key) => !SUPPORTED_SETTINGS.has(key),
    );
    if (unsupportedSettings.length > 0) {
      unsupported("unsupported_search_setting", unsupportedSettings.map((key) => `settings.${key}`));
    }
  }
  const queries = parseQueries(payload.commands);
  const responseLength = parseResponseLength(payload.commands);
  validateSearchMetadata(payload.settings);
  const filters = parseFilters(payload.settings);
  for (const query of queries) {
    intersectDomains(query.domains, filters.allowedDomains);
  }
  return {
    model: payload.model,
    queries,
    filters,
    ...(responseLength === undefined ? {} : { responseLength }),
  };
}
