import { ConfigError, loadConfig } from "./config.ts";
import {
  clearServiceHealth,
  listCoolingServices,
  type HealthScope,
} from "./health.ts";
import { bearerToken, findClientApiKey, jsonResponse, openAiError } from "./http.ts";
import {
  elapsedMs,
  errorMessage,
  configureLogging,
  logError,
  logInfo,
  logWarn,
  newRequestId,
  registerSensitiveValues,
  requestUserAgent,
} from "./log.ts";
import { handleModels } from "./models.ts";
import { handleInference } from "./proxy.ts";
import type { ClientApiKeyConfig } from "./types.ts";

type InferencePath = "responses" | "chat/completions";
type GatewayEndpoint = "models" | "health" | InferencePath;

type GatewayRoute =
  | { endpoint: Exclude<GatewayEndpoint, "health"> }
  | { endpoint: "health"; action: "list" }
  | { endpoint: "health"; action: "clear"; serviceId: string };

function route(pathname: string): GatewayRoute | undefined {
  const healthMatch = pathname.match(/^\/(?:v1\/)?health\/([A-Za-z0-9._-]+)$/);
  if (healthMatch) {
    return { endpoint: "health", action: "clear", serviceId: healthMatch[1] };
  }
  switch (pathname) {
    case "/health":
    case "/v1/health":
      return { endpoint: "health", action: "list" };
    case "/models":
    case "/v1/models":
      return { endpoint: "models" };
    case "/responses":
    case "/v1/responses":
      return { endpoint: "responses" };
    case "/chat/completions":
    case "/v1/chat/completions":
      return { endpoint: "chat/completions" };
    default:
      return undefined;
  }
}

function healthScope(incomingUrl: URL): HealthScope | undefined {
  const scope = incomingUrl.searchParams.get("scope") ?? "inference";
  return scope === "inference" || scope === "catalog" ? scope : undefined;
}

function invalidHealthScope(): Response {
  return openAiError(
    400,
    "scope must be inference or catalog",
    "invalid_request_error",
    "invalid_health_scope",
  );
}

function expectedMethod(route: GatewayRoute): "GET" | "POST" | "DELETE" {
  if (route.endpoint === "models" || (route.endpoint === "health" && route.action === "list")) {
    return "GET";
  }
  return route.endpoint === "health" ? "DELETE" : "POST";
}

async function handleHealthList(
  env: Env,
  client: ClientApiKeyConfig,
  incomingUrl: URL,
): Promise<Response> {
  const scope = healthScope(incomingUrl);
  if (!scope) {
    return invalidHealthScope();
  }
  return jsonResponse({
    object: "list",
    scope,
    data: await listCoolingServices(env, client.services, scope),
  });
}

async function handleHealthClear(
  env: Env,
  client: ClientApiKeyConfig,
  incomingUrl: URL,
  serviceId: string,
  requestId: string,
): Promise<Response> {
  if (!client.services.includes(serviceId)) {
    return openAiError(
      404,
      `Service ${serviceId} is not available for this API key`,
      "invalid_request_error",
      "service_not_found",
    );
  }
  const scope = healthScope(incomingUrl);
  if (!scope) {
    return invalidHealthScope();
  }
  const snapshot = await clearServiceHealth(env, serviceId, requestId, scope);
  return jsonResponse({
    service_id: serviceId,
    scope,
    ...snapshot,
  });
}

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    configureLogging(env.LOG_LEVEL);
    const startedAt = performance.now();
    const requestId = newRequestId();
    const incomingUrl = new URL(request.url);
    const matchedRoute = route(incomingUrl.pathname);
    const endpoint = matchedRoute?.endpoint;
    logInfo("request.started", {
      request_id: requestId,
      method: request.method,
      path: incomingUrl.pathname,
      endpoint,
      user_agent: requestUserAgent(request),
    });
    const finish = (response: Response): Response => {
      logInfo("request.completed", {
        request_id: requestId,
        method: request.method,
        path: incomingUrl.pathname,
        endpoint,
        status: response.status,
        duration_ms: elapsedMs(startedAt),
      });
      return response;
    };

    if (!endpoint) {
      logWarn("request.route.not_found", {
        request_id: requestId,
        path: incomingUrl.pathname,
      });
      return finish(openAiError(404, "Not found", "invalid_request_error", "not_found"));
    }
    const allowedMethod = expectedMethod(matchedRoute);
    if (request.method !== allowedMethod) {
      logWarn("request.method.rejected", {
        request_id: requestId,
        endpoint,
        method: request.method,
        expected_method: allowedMethod,
      });
      return finish(openAiError(405, `Only ${allowedMethod} is allowed for this endpoint`));
    }

    let config;
    try {
      config = await loadConfig(env, requestId);
    } catch (error) {
      const message = error instanceof ConfigError ? error.message : "configuration is unavailable";
      logError("request.configuration.failed", {
        request_id: requestId,
        error: errorMessage(error),
      });
      return finish(openAiError(500, message, "server_error", "configuration_error"));
    }

    registerSensitiveValues([
      ...config.services.map((service) => service.api_key),
      ...config.api_keys.map((entry) => entry.api_key),
    ]);

    const client = await findClientApiKey(request, config.api_keys);
    if (!client) {
      logWarn("request.authentication.rejected", {
        request_id: requestId,
        endpoint,
      });
      return finish(openAiError(401, "Invalid API key", "invalid_request_error", "invalid_api_key"));
    }

    const clientToken = bearerToken(request);
    if (clientToken) {
      registerSensitiveValues([clientToken]);
    }

    logInfo("request.authentication.accepted", {
      request_id: requestId,
      endpoint,
      allowed_service_count: client.services.length,
    });

    try {
      const response = matchedRoute.endpoint === "models"
        ? await handleModels(request, env, config, client, requestId, context)
        : matchedRoute.endpoint === "health"
        ? matchedRoute.action === "list"
          ? await handleHealthList(env, client, incomingUrl)
          : await handleHealthClear(
            env,
            client,
            incomingUrl,
            matchedRoute.serviceId,
            requestId,
          )
        : await handleInference(
          request,
          env,
          config,
          client,
          matchedRoute.endpoint,
          requestId,
          context,
        );
      return finish(response);
    } catch (error) {
      logError("request.handler.failed", {
        request_id: requestId,
        endpoint,
        error: errorMessage(error),
      });
      return finish(openAiError(500, "The gateway failed to process the request", "server_error", "gateway_error"));
    }
  },
} satisfies ExportedHandler<Env>;
