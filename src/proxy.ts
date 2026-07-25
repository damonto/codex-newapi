import {
  recordServiceFailure,
  recordServiceSuccess,
  scheduleHealthUpdate,
  type HealthExecutionContext,
} from "./health.ts";
import {
  forwardRequestHeaders,
  openAiError,
  upstreamUrl,
} from "./http.ts";
import {
  bounded,
  elapsedMs,
  errorMessage,
  logInfo,
  logWarn,
  registerSensitiveValues,
} from "./log.ts";
import { resolveModelRoute, selectAvailableService } from "./routing.ts";
import type { ClientApiKeyConfig, Env, GatewayConfig } from "./types.ts";

interface InferencePayload {
  [key: string]: unknown;
  model: string;
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
  upstreamPath: "responses" | "chat/completions",
  requestId = "unknown",
  context?: HealthExecutionContext,
): Promise<Response> {
  const rawBody = await request.arrayBuffer();
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
  if (payload.model !== route.upstreamModel) {
    headers.delete("content-md5");
    headers.delete("digest");
    headers.delete("content-digest");
    headers.delete("content-encoding");
  }
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const body: BodyInit =
    payload.model === route.upstreamModel
      ? rawBody
      : rewriteModel(originalText, payload, route.upstreamModel);
  const incomingUrl = new URL(request.url);
  const startedAt = performance.now();
  logInfo("inference.upstream.request", {
    request_id: requestId,
    endpoint: upstreamPath,
    service_id: service.id,
    upstream_model: bounded(route.upstreamModel, 160),
    model_rewritten: payload.model !== route.upstreamModel,
  });

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(
      new Request(upstreamUrl(service, upstreamPath, incomingUrl.search), {
        method: request.method,
        headers,
        body,
        redirect: "manual",
      }),
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
    if (upstreamResponse.status === 400) {
      await scheduleHealthUpdate(
        context,
        recordServiceFailure(env, service.id, requestId),
      );
    }
  }
  return upstreamResponse;
}
