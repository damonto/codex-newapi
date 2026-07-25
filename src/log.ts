export type LogFields = Record<string, unknown>;
export type LogLevel = "info" | "warn" | "error" | "off";

const LOG_LEVEL_ORDER: Record<Exclude<LogLevel, "off">, number> = {
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
let sensitiveValues: string[] = [];

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

export function registerSensitiveValues(values: Iterable<unknown>): void {
  sensitiveValues = [...new Set(
    [...sensitiveValues, ...values]
      .filter((value): value is string => typeof value === "string" && value.length >= 3)
      .map((value) => value.slice(0, 4096)),
  )]
    .sort((left, right) => right.length - left.length)
    .slice(0, 256);
}

export function redactText(value: string): string {
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

function sanitizeValue(value: unknown, key: string | undefined, seen: WeakSet<object>): unknown {
  if (key && SENSITIVE_FIELD.test(key)) {
    return REDACTED;
  }
  if (typeof value === "string") {
    return redactText(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const sanitized = value.map((entry) => sanitizeValue(entry, undefined, seen));
    seen.delete(value);
    return sanitized;
  }
  const sanitized: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    sanitized[entryKey] = sanitizeValue(entryValue, entryKey, seen);
  }
  seen.delete(value);
  return sanitized;
}

function sanitizeFields(fields: LogFields): LogFields {
  return sanitizeValue(fields, undefined, new WeakSet<object>()) as LogFields;
}

function shouldEmit(level: Exclude<LogLevel, "off">): boolean {
  if (currentLogLevel === "off") {
    return false;
  }
  return LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[currentLogLevel];
}

function emit(level: Exclude<LogLevel, "off">, event: string, fields: LogFields = {}): void {
  if (!shouldEmit(level)) {
    return;
  }
  let entry: string;
  try {
    entry = JSON.stringify({ event: redactText(event), ...sanitizeFields(fields) });
  } catch {
    entry = JSON.stringify({ event: redactText(event), logging_error: "fields_not_serializable" });
  }
  if (level === "error") {
    console.error(entry);
  } else if (level === "warn") {
    console.warn(entry);
  } else {
    console.log(entry);
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
