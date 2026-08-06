import {
  recordServiceFailure,
  recordServiceSuccess,
  isHealthFailureStatus,
  scheduleHealthUpdate,
  type HealthExecutionContext,
} from "./health.ts";
import {
  forwardRequestHeaders,
  openAiError,
  upstreamUrl,
} from "./http.ts";
import {
  BodyTooLargeError,
  discardBody,
  readBodyWithinLimit,
} from "./body.ts";
import { upstreamApiKeyValues } from "./credentials.ts";
import {
  bounded,
  elapsedMs,
  errorMessage,
  type RequestLogContext,
} from "./log.ts";
import {
  resolveModelRoute,
  selectAvailableServiceWithDetails,
} from "./routing.ts";
import type {
  ClientApiKeyConfig,
  GatewayConfig,
  ServiceRetryConfig,
} from "./types.ts";
import {
  hasJsonUpstreamError,
  upstreamErrorStatusFields,
  upstreamResponseFields,
  upstreamResponseLogFields,
} from "./upstream-log.ts";

interface InferencePayload {
  [key: string]: unknown;
  model: string;
}

export type InferencePath =
  | "responses"
  | "chat/completions"
  | "images/generations"
  | "images/edits";

const MAX_INFERENCE_BODY_MIB = 96;
export const MAX_INFERENCE_BODY_BYTES = MAX_INFERENCE_BODY_MIB * 1024 * 1024;

interface InferenceRetryOptions {
  wait?: (delayMs: number) => Promise<void>;
}

interface UpstreamAttemptLog {
  attempt: number;
  status?: number;
  duration_ms: number;
  retry_delay_ms?: number;
  error?: string;
}

interface FetchWithRetriesResult {
  response?: Response;
  attempts: UpstreamAttemptLog[];
  error?: unknown;
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function fetchWithConfiguredRetries(
  makeRequest: () => Request,
  retry: ServiceRetryConfig | undefined,
  retryOptions: InferenceRetryOptions,
): Promise<FetchWithRetriesResult> {
  const attempts: UpstreamAttemptLog[] = [];
  for (let attemptIndex = 0; ; attemptIndex += 1) {
    const attemptStartedAt = performance.now();
    let response: Response;
    try {
      response = await fetch(makeRequest());
    } catch (error) {
      attempts.push({
        attempt: attemptIndex + 1,
        duration_ms: elapsedMs(attemptStartedAt),
        error: errorMessage(error),
      });
      return { attempts, error };
    }

    const attempt: UpstreamAttemptLog = {
      attempt: attemptIndex + 1,
      status: response.status,
      duration_ms: elapsedMs(attemptStartedAt),
    };
    attempts.push(attempt);
    const delayMs = retry?.delays_ms[attemptIndex];
    if (
      retry === undefined ||
      delayMs === undefined ||
      !retry.status_codes.includes(response.status)
    ) {
      return { response, attempts };
    }

    attempt.retry_delay_ms = delayMs;
    await discardBody(response.body);
    try {
      await (retryOptions.wait ?? wait)(delayMs);
    } catch (error) {
      return { attempts, error };
    }
  }
}

function parseInferencePayload(text: string): InferencePayload {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error("request body must be valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("request body must be a JSON object");
  }
  const model = (value as Record<string, unknown>).model;
  if (typeof model !== "string" || model.trim() === "") {
    throw new Error("request body must contain a non-empty model string");
  }
  return value as InferencePayload;
}

export function rewriteModel(
  originalText: string,
  payload: InferencePayload,
  upstreamModel: string,
): string {
  if (payload.model === upstreamModel) {
    return originalText;
  }
  return JSON.stringify({ ...payload, model: upstreamModel });
}

export async function handleInference(
  request: Request,
  env: Env,
  config: GatewayConfig,
  client: ClientApiKeyConfig,
  upstreamPath: InferencePath,
  requestId = "unknown",
  context?: HealthExecutionContext,
  retryOptions: InferenceRetryOptions = {},
  requestLog?: RequestLogContext,
): Promise<Response> {
  requestLog?.registerSensitiveValues([
    client.api_key,
    ...upstreamApiKeyValues(config),
  ]);
  let rawBody: Uint8Array<ArrayBuffer>;
  try {
    rawBody = await readBodyWithinLimit(
      request.body,
      MAX_INFERENCE_BODY_BYTES,
      request.headers.get("content-length"),
    );
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      requestLog?.warn({
        outcome: "request_too_large",
        inference: { max_body_bytes: MAX_INFERENCE_BODY_BYTES },
      });
      return openAiError(
        413,
        `Request body exceeds the ${MAX_INFERENCE_BODY_MIB} MiB limit`,
        "invalid_request_error",
        "request_too_large",
      );
    }
    throw error;
  }
  const originalText = new TextDecoder().decode(rawBody);
  requestLog?.mergeSection("inference", { body_bytes: rawBody.byteLength });
  let payload: InferencePayload;
  try {
    payload = parseInferencePayload(originalText);
  } catch (error) {
    requestLog?.warn({
      outcome: "invalid_request",
      error: errorMessage(error),
    });
    return openAiError(400, error instanceof Error ? error.message : "invalid request body");
  }

  const route = resolveModelRoute(config, client, payload.model);
  const candidateServices = route.targets.map((target) => target.service.id);
  requestLog?.set({
    model: {
      requested: bounded(payload.model, 160),
      upstream: bounded(route.upstreamModel, 160),
      route_applied: route.routeApplied,
    },
    routing: { candidate_services: candidateServices },
  });
  if (route.targets.length === 0) {
    requestLog?.warn({ outcome: "model_not_found" });
    return openAiError(400, `Model ${payload.model} is not available for this API key`, "invalid_request_error", "model_not_found");
  }
  const selection = await selectAvailableServiceWithDetails(env, route);
  const target = selection.target;
  const routing = {
    candidate_services: candidateServices,
    checked_available_services: selection.checks
      .filter((check) => check.available)
      .map((check) => check.service_id),
    service_checks: selection.checks,
    ...(target
      ? {
        selected_service: target.service.id,
        selected_key_id: target.key.id,
      }
      : {}),
  };
  if (selection.checks.some((check) => check.reason === "health_read_failed")) {
    requestLog?.warn({ routing });
  } else {
    requestLog?.set({ routing });
  }
  if (!target) {
    requestLog?.warn({ outcome: "service_cooling_down" });
    return openAiError(503, `No healthy service is currently available for model ${payload.model}`, "server_error", "service_cooling_down");
  }
  const { service, key: selectedKey } = target;

  const headers = forwardRequestHeaders(request, selectedKey.api_key);
  headers.delete("content-length");
  const modelRewritten = payload.model !== route.upstreamModel;
  if (modelRewritten) {
    headers.delete("content-md5");
    headers.delete("digest");
    headers.delete("content-digest");
    headers.delete("content-encoding");
  }
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  let body: BodyInit = rawBody;
  if (modelRewritten) {
    body = rewriteModel(originalText, payload, route.upstreamModel);
  }
  const incomingUrl = new URL(request.url);
  const startedAt = performance.now();
  const result = await fetchWithConfiguredRetries(
    () => new Request(upstreamUrl(service, upstreamPath, incomingUrl.search), {
      method: request.method,
      headers,
      body,
      redirect: "manual",
    }),
    service.retry,
    retryOptions,
  );
  const upstreamDurationMs = elapsedMs(startedAt);
  if (!result.response) {
    requestLog?.warn({
      outcome: "upstream_unavailable",
      upstream: {
        service_id: service.id,
        key_id: selectedKey.id,
        model: bounded(route.upstreamModel, 160),
        model_rewritten: modelRewritten,
        duration_ms: upstreamDurationMs,
        attempts: result.attempts,
        error: errorMessage(result.error),
      },
    });
    await scheduleHealthUpdate(
      context,
      recordServiceFailure(env, service.id, requestId),
    );
    return openAiError(502, "The selected upstream service could not be reached", "server_error", "upstream_unavailable");
  }

  const upstreamResponse = result.response;
  if (requestLog) {
    const upstreamBase = {
      service_id: service.id,
      key_id: selectedKey.id,
      model: bounded(route.upstreamModel, 160),
      model_rewritten: modelRewritten,
      duration_ms: upstreamDurationMs,
      attempts: result.attempts,
    };
    if (upstreamResponse.ok) {
      requestLog.set({
        outcome: "success",
        upstream: {
          ...upstreamBase,
          ...upstreamResponseFields(upstreamResponse),
        },
      });
    } else {
      requestLog.warn({
        outcome: "upstream_error",
        upstream: {
          ...upstreamBase,
          ...upstreamErrorStatusFields(upstreamResponse),
        },
      });
      if (hasJsonUpstreamError(upstreamResponse)) {
        const responseFields = upstreamResponseLogFields(upstreamResponse);
        requestLog.defer(responseFields.then((fields) => {
          requestLog.set({
            upstream: {
              ...upstreamBase,
              ...requestLog.limitUpstreamErrorFields(fields),
            },
          });
        }));
      }
    }
  }

  if (upstreamResponse.ok) {
    await scheduleHealthUpdate(
      context,
      recordServiceSuccess(env, service.id, requestId),
    );
  } else {
    if (isHealthFailureStatus(upstreamResponse.status)) {
      await scheduleHealthUpdate(
        context,
        recordServiceFailure(env, service.id, requestId),
      );
    }
  }
  return upstreamResponse;
}
