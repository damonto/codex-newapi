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
import {
  bounded,
  elapsedMs,
  errorMessage,
  logInfo,
  logWarn,
  registerSensitiveValues,
} from "./log.ts";
import { resolveModelRoute, selectAvailableService } from "./routing.ts";
import type {
  ClientApiKeyConfig,
  GatewayConfig,
  ServiceRetryConfig,
} from "./types.ts";

interface InferencePayload {
  [key: string]: unknown;
  model: string;
}

export type InferencePath =
  | "responses"
  | "chat/completions"
  | "images/generations"
  | "images/edits";

export const MAX_INFERENCE_BODY_BYTES = 64 * 1024 * 1024;

interface InferenceRetryOptions {
  wait?: (delayMs: number) => Promise<void>;
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function fetchWithConfiguredRetries(
  makeRequest: () => Request,
  requestId: string,
  upstreamPath: InferencePath,
  serviceId: string,
  retry: ServiceRetryConfig | undefined,
  retryOptions: InferenceRetryOptions,
): Promise<Response> {
  let response = await fetch(makeRequest());
  if (retry === undefined) {
    return response;
  }
  for (const [retryIndex, delayMs] of retry.delays_ms.entries()) {
    if (!retry.status_codes.includes(response.status)) {
      break;
    }

    await discardBody(response.body);
    logWarn("inference.upstream.retry_scheduled", {
      request_id: requestId,
      endpoint: upstreamPath,
      service_id: serviceId,
      status: response.status,
      retry: retryIndex + 1,
      max_retries: retry.delays_ms.length,
      retry_delay_ms: delayMs,
    });
    await (retryOptions.wait ?? wait)(delayMs);
    response = await fetch(makeRequest());
  }
  return response;
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
): Promise<Response> {
  let rawBody: Uint8Array<ArrayBuffer>;
  try {
    rawBody = await readBodyWithinLimit(
      request.body,
      MAX_INFERENCE_BODY_BYTES,
      request.headers.get("content-length"),
    );
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      logWarn("inference.request.too_large", {
        request_id: requestId,
        endpoint: upstreamPath,
        max_body_bytes: MAX_INFERENCE_BODY_BYTES,
      });
      return openAiError(
        413,
        "Request body exceeds the 64 MiB limit",
        "invalid_request_error",
        "request_too_large",
      );
    }
    throw error;
  }
  const originalText = new TextDecoder().decode(rawBody);
  logInfo("inference.request.started", {
    request_id: requestId,
    endpoint: upstreamPath,
    body_bytes: rawBody.byteLength,
  });
  let payload: InferencePayload;
  try {
    payload = parseInferencePayload(originalText);
  } catch (error) {
    logWarn("inference.request.invalid", {
      request_id: requestId,
      endpoint: upstreamPath,
      error: errorMessage(error),
    });
    return openAiError(400, error instanceof Error ? error.message : "invalid request body");
  }

  const route = resolveModelRoute(config, client, payload.model);
  logInfo("inference.route.resolved", {
    request_id: requestId,
    endpoint: upstreamPath,
    requested_model: bounded(payload.model, 160),
    upstream_model: bounded(route.upstreamModel, 160),
    alias_applied: payload.model !== route.upstreamModel,
    candidate_service_ids: route.services.map((service) => service.id),
  });
  if (route.services.length === 0) {
    logWarn("inference.route.unavailable", {
      request_id: requestId,
      endpoint: upstreamPath,
      requested_model: bounded(payload.model, 160),
    });
    return openAiError(400, `Model ${payload.model} is not available for this API key`, "invalid_request_error", "model_not_found");
  }
  const service = await selectAvailableService(env, route, requestId);
  if (!service) {
    logWarn("inference.route.cooling_down", {
      request_id: requestId,
      endpoint: upstreamPath,
      requested_model: bounded(payload.model, 160),
      candidate_service_ids: route.services.map((entry) => entry.id),
    });
    return openAiError(503, `No healthy service is currently available for model ${payload.model}`, "server_error", "service_cooling_down");
  }

  registerSensitiveValues([service.api_key]);
  const headers = forwardRequestHeaders(request, service.api_key);
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
  logInfo("inference.upstream.request", {
    request_id: requestId,
    endpoint: upstreamPath,
    service_id: service.id,
    upstream_model: bounded(route.upstreamModel, 160),
    model_rewritten: modelRewritten,
  });

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetchWithConfiguredRetries(
      () => new Request(upstreamUrl(service, upstreamPath, incomingUrl.search), {
        method: request.method,
        headers,
        body,
        redirect: "manual",
      }),
      requestId,
      upstreamPath,
      service.id,
      service.retry,
      retryOptions,
    );
  } catch (error) {
    logWarn("inference.upstream.exception", {
      request_id: requestId,
      endpoint: upstreamPath,
      service_id: service.id,
      error: errorMessage(error),
      duration_ms: elapsedMs(startedAt),
    });
    await scheduleHealthUpdate(
      context,
      recordServiceFailure(env, service.id, requestId),
    );
    return openAiError(502, "The selected upstream service could not be reached", "server_error", "upstream_unavailable");
  }

  if (upstreamResponse.ok) {
    logInfo("inference.upstream.succeeded", {
      request_id: requestId,
      endpoint: upstreamPath,
      service_id: service.id,
      status: upstreamResponse.status,
      duration_ms: elapsedMs(startedAt),
    });
    await scheduleHealthUpdate(
      context,
      recordServiceSuccess(env, service.id, requestId),
    );
  } else {
    logWarn("inference.upstream.failed", {
      request_id: requestId,
      endpoint: upstreamPath,
      service_id: service.id,
      status: upstreamResponse.status,
      duration_ms: elapsedMs(startedAt),
    });
    if (isHealthFailureStatus(upstreamResponse.status)) {
      await scheduleHealthUpdate(
        context,
        recordServiceFailure(env, service.id, requestId),
      );
    }
  }
  return upstreamResponse;
}
