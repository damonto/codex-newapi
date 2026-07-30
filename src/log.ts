export type LogFields = Record<string, unknown>;
export type LogLevel = "info" | "warn" | "error" | "off";
type EmittedLogLevel = Exclude<LogLevel, "off">;

export interface LogExecutionContext {
  waitUntil?: (promise: Promise<unknown>) => void;
}

export const MAX_REQUEST_LOGGED_UPSTREAM_ERROR_BYTES = 32 * 1024;

const LOG_LEVEL_ORDER: Record<EmittedLogLevel, number> = {
  info: 1,
  warn: 2,
  error: 3,
};
const REDACTED = "[REDACTED]";
const SENSITIVE_FIELD = /(?:^|[_-])(?:authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|x-api-key|x-auth-token|x-access-token|x-client-key|token|access[-_]?token|refresh[-_]?token|secret|password|credential|credentials)(?:$|[_-])/i;
const BEARER_PATTERN = /\b(Bearer|Basic)\s+[^\s,;]+/gi;
const QUERY_SECRET_PATTERN = /([?&](?:api[-_]?key|token|access[-_]?token|refresh[-_]?token|secret|password|authorization)\s*=)[^&#\s]+/gi;
const ASSIGNMENT_SECRET_PATTERN = /((?:["']?(?:api[-_]?key|token|access[-_]?token|refresh[-_]?token|secret|password|authorization|credential)s?["']?)\s*[:=]\s*["']?)[^"'\s,}&]+/gi;
const OPENAI_KEY_PATTERN = /\bsk-[A-Za-z0-9][A-Za-z0-9._-]{7,}\b/g;

let currentLogLevel: LogLevel = "info";

export function configureLogging(value: unknown): LogLevel {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  currentLogLevel = normalized === "none" || normalized === "silent"
    ? "off"
    : normalized === "info" || normalized === "warn" || normalized === "error" || normalized === "off"
      ? normalized
      : "info";
  return currentLogLevel;
}

export function getLogLevel(): LogLevel {
  return currentLogLevel;
}

function normalizedSensitiveValues(values: Iterable<unknown>): string[] {
  return [...values]
    .filter((value): value is string => typeof value === "string" && value.length >= 3)
    .map((value) => value.slice(0, 4096));
}

function redactTextWithSensitiveValues(
  value: string,
  sensitiveValues: readonly string[],
): string {
  let redacted = value
    .replace(BEARER_PATTERN, `$1 ${REDACTED}`)
    .replace(QUERY_SECRET_PATTERN, `$1${REDACTED}`)
    .replace(ASSIGNMENT_SECRET_PATTERN, `$1${REDACTED}`)
    .replace(OPENAI_KEY_PATTERN, REDACTED);
  for (const sensitiveValue of sensitiveValues) {
    redacted = redacted.split(sensitiveValue).join(REDACTED);
  }
  return redacted;
}

export function redactText(value: string): string {
  return redactTextWithSensitiveValues(value, []);
}

function sanitizeValue(
  value: unknown,
  key: string | undefined,
  seen: WeakSet<object>,
  sensitiveValues: readonly string[],
): unknown {
  if (key && SENSITIVE_FIELD.test(key)) {
    return REDACTED;
  }
  if (typeof value === "string") {
    return redactTextWithSensitiveValues(value, sensitiveValues);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const sanitized = value.map((entry) =>
      sanitizeValue(entry, undefined, seen, sensitiveValues)
    );
    seen.delete(value);
    return sanitized;
  }
  const sanitized: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    sanitized[entryKey] = sanitizeValue(entryValue, entryKey, seen, sensitiveValues);
  }
  seen.delete(value);
  return sanitized;
}

function sanitizeFields(fields: LogFields, sensitiveValues: readonly string[]): LogFields {
  return sanitizeValue(
    fields,
    undefined,
    new WeakSet<object>(),
    sensitiveValues,
  ) as LogFields;
}

function shouldEmit(level: EmittedLogLevel): boolean {
  if (currentLogLevel === "off") {
    return false;
  }
  return LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[currentLogLevel];
}

function emit(
  level: EmittedLogLevel,
  event: string,
  fields: LogFields = {},
  sensitiveValues: readonly string[] = [],
): void {
  if (!shouldEmit(level)) {
    return;
  }
  const message = redactTextWithSensitiveValues(event, sensitiveValues);
  let entry: LogFields;
  try {
    entry = {
      ...sanitizeFields(fields, sensitiveValues),
      event: message,
      level,
      message,
    };
    JSON.stringify(entry);
  } catch {
    entry = {
      event: message,
      level,
      message,
      logging_error: "fields_not_serializable",
    };
  }
  if (level === "error") {
    console.error(entry);
  } else if (level === "warn") {
    console.warn(entry);
  } else {
    console.info(entry);
  }
}

export function logInfo(event: string, fields?: LogFields): void {
  emit("info", event, fields);
}

export function logWarn(event: string, fields?: LogFields): void {
  emit("warn", event, fields);
}

export function logError(event: string, fields?: LogFields): void {
  emit("error", event, fields);
}

function strongerLevel(
  left: EmittedLogLevel,
  right: EmittedLogLevel,
): EmittedLogLevel {
  return LOG_LEVEL_ORDER[left] >= LOG_LEVEL_ORDER[right] ? left : right;
}

function isLogFields(value: unknown): value is LogFields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class RequestLogContext {
  private readonly startedAt = performance.now();
  private readonly fields: LogFields;
  private readonly deferred: Promise<void>[] = [];
  private level: EmittedLogLevel = "info";
  private completed = false;
  private completionPromise?: Promise<void>;
  private remainingErrorBodyBytes = MAX_REQUEST_LOGGED_UPSTREAM_ERROR_BYTES;
  private sensitiveValues: string[] = [];

  constructor(
    readonly requestId: string,
    request: Request,
    endpoint?: string,
    private readonly executionContext?: LogExecutionContext,
  ) {
    const url = new URL(request.url);
    this.fields = {
      request_id: requestId,
      method: request.method,
      path: url.pathname,
      ...(endpoint === undefined ? {} : { endpoint }),
    };
  }

  set(fields: LogFields): void {
    Object.assign(this.fields, fields);
  }

  registerSensitiveValues(values: Iterable<unknown>): void {
    this.sensitiveValues = [...new Set([
      ...this.sensitiveValues,
      ...normalizedSensitiveValues(values),
    ])].sort((left, right) => right.length - left.length);
  }

  mergeSection(section: string, fields: LogFields): void {
    const current = this.fields[section];
    this.fields[section] = isLogFields(current)
      ? { ...current, ...fields }
      : { ...fields };
  }

  warn(fields: LogFields = {}): void {
    this.level = strongerLevel(this.level, "warn");
    this.set(fields);
  }

  error(fields: LogFields = {}): void {
    this.level = "error";
    this.set(fields);
  }

  defer(task: Promise<void>): void {
    if (this.completed) {
      throw new Error("request log is already completed");
    }
    this.deferred.push(task);
  }

  limitUpstreamErrorFields(fields: LogFields): LogFields {
    const bytes = fields.error_body_bytes;
    if (
      !Object.hasOwn(fields, "error_json") ||
      typeof bytes !== "number" ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0
    ) {
      return fields;
    }
    if (bytes <= this.remainingErrorBodyBytes) {
      this.remainingErrorBodyBytes -= bytes;
      return fields;
    }
    const { error_json: _errorJson, ...metadata } = fields;
    return {
      ...metadata,
      error_json_omitted: "request_log_budget_exceeded",
      error_body_limit_bytes: MAX_REQUEST_LOGGED_UPSTREAM_ERROR_BYTES,
    };
  }

  private emitSummary(status: number, ok: boolean, durationMs: number): void {
    emit(
      this.level,
      "request.summary",
      {
        ...this.fields,
        outcome: this.fields.outcome ?? (ok ? "success" : "failed"),
        response_status: status,
        duration_ms: durationMs,
      },
      this.sensitiveValues,
    );
  }

  complete(response: Response): Response {
    if (this.completed) {
      return response;
    }
    this.completed = true;
    if (response.status >= 500) {
      this.level = "error";
    } else if (response.status >= 400) {
      this.level = strongerLevel(this.level, "warn");
    }
    const status = response.status;
    const ok = response.ok;
    const durationMs = elapsedMs(this.startedAt);
    if (this.deferred.length === 0) {
      this.emitSummary(status, ok, durationMs);
      return response;
    }

    const completion = Promise.allSettled(this.deferred).then((results) => {
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [errorMessage(result.reason)] : []
      );
      if (errors.length > 0) {
        this.mergeSection("logging", { deferred_errors: errors });
      }
      this.emitSummary(status, ok, durationMs);
    });
    this.completionPromise = completion;
    if (typeof this.executionContext?.waitUntil === "function") {
      try {
        this.executionContext.waitUntil(completion);
      } catch {
        void completion;
      }
    } else {
      void completion;
    }
    return response;
  }

  waitForCompletion(): Promise<void> {
    return this.completionPromise ?? Promise.resolve();
  }
}

export function newRequestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

export function bounded(value: unknown, maxLength = 256): string {
  const text = String(value);
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}

export function errorMessage(error: unknown): string {
  let message: string;
  if (error instanceof Error) {
    message = error.message;
  } else if (typeof error === "string") {
    message = error;
  } else {
    try {
      message = JSON.stringify(error) ?? String(error);
    } catch {
      message = String(error);
    }
  }
  return bounded(redactText(message));
}

export function requestUserAgent(request: Request): string | undefined {
  const value = request.headers.get("user-agent");
  return value ? bounded(value, 160) : undefined;
}
