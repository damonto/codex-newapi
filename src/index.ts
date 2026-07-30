import { ConfigError, loadConfig } from "./config.ts";
import {
  clearServiceHealth,
  listCoolingServices,
  type HealthScope,
} from "./health.ts";
import { bearerToken, findClientApiKey, jsonResponse, openAiError } from "./http.ts";
import {
  errorMessage,
  configureLogging,
  newRequestId,
  RequestLogContext,
} from "./log.ts";
import { handleModels } from "./models.ts";
import { handleInference, type InferencePath } from "./proxy.ts";
import type { ClientApiKeyConfig } from "./types.ts";

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
    case "/images/generations":
    case "/v1/images/generations":
      return { endpoint: "images/generations" };
    case "/images/edits":
    case "/v1/images/edits":
      return { endpoint: "images/edits" };
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
  requestLog: RequestLogContext,
): Promise<Response> {
  const scope = healthScope(incomingUrl);
  if (!scope) {
    requestLog.warn({
      outcome: "invalid_health_scope",
      health: { action: "list", scope: incomingUrl.searchParams.get("scope") },
    });
    return invalidHealthScope();
  }
  const data = await listCoolingServices(env, client.services, scope);
  requestLog.set({
    health: {
      action: "list",
      scope,
      cooling_services: data.map((entry) => entry.service_id),
    },
  });
  return jsonResponse({
    object: "list",
    scope,
    data,
  });
}

async function handleHealthClear(
  env: Env,
  client: ClientApiKeyConfig,
  incomingUrl: URL,
  serviceId: string,
  requestId: string,
  requestLog: RequestLogContext,
): Promise<Response> {
  if (!client.services.includes(serviceId)) {
    requestLog.warn({
      outcome: "service_not_found",
      health: { action: "clear", service_id: serviceId },
    });
    return openAiError(
      404,
      `Service ${serviceId} is not available for this API key`,
      "invalid_request_error",
      "service_not_found",
    );
  }
  const scope = healthScope(incomingUrl);
  if (!scope) {
    requestLog.warn({
      outcome: "invalid_health_scope",
      health: {
        action: "clear",
        service_id: serviceId,
        scope: incomingUrl.searchParams.get("scope"),
      },
    });
    return invalidHealthScope();
  }
  const snapshot = await clearServiceHealth(env, serviceId, requestId, scope);
  requestLog.set({
    health: {
      action: "clear",
      service_id: serviceId,
      scope,
      ...snapshot,
    },
  });
  return jsonResponse({
    service_id: serviceId,
    scope,
    ...snapshot,
  });
}

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    configureLogging(env.LOG_LEVEL);
    const requestId = newRequestId();
    const incomingUrl = new URL(request.url);
    const matchedRoute = route(incomingUrl.pathname);
    const endpoint = matchedRoute?.endpoint;
    const requestLog = new RequestLogContext(requestId, request, endpoint, context);
    const finish = (response: Response): Response => requestLog.complete(response);
    const clientToken = bearerToken(request);
    if (clientToken) {
      requestLog.registerSensitiveValues([clientToken]);
    }

    if (!endpoint) {
      requestLog.warn({ outcome: "route_not_found" });
      return finish(openAiError(404, "Not found", "invalid_request_error", "not_found"));
    }
    const allowedMethod = expectedMethod(matchedRoute);
    if (request.method !== allowedMethod) {
      requestLog.warn({
        outcome: "method_rejected",
        expected_method: allowedMethod,
      });
      return finish(openAiError(405, `Only ${allowedMethod} is allowed for this endpoint`));
    }

    let config;
    try {
      config = await loadConfig(env, requestId, requestLog);
    } catch (error) {
      const message = error instanceof ConfigError ? error.message : "configuration is unavailable";
      requestLog.error({
        outcome: "configuration_error",
        error: errorMessage(error),
      });
      return finish(openAiError(500, message, "server_error", "configuration_error"));
    }

    const client = await findClientApiKey(request, config.api_keys);
    if (!client) {
      requestLog.warn({
        outcome: "authentication_rejected",
        authentication: "rejected",
      });
      return finish(openAiError(401, "Invalid API key", "invalid_request_error", "invalid_api_key"));
    }

    requestLog.registerSensitiveValues([client.api_key]);

    requestLog.set({
      authentication: "accepted",
      allowed_services: [...client.services],
    });

    try {
      const response = matchedRoute.endpoint === "models"
        ? await handleModels(request, env, config, client, requestId, context, requestLog)
        : matchedRoute.endpoint === "health"
        ? matchedRoute.action === "list"
          ? await handleHealthList(env, client, incomingUrl, requestLog)
          : await handleHealthClear(
            env,
            client,
            incomingUrl,
            matchedRoute.serviceId,
            requestId,
            requestLog,
          )
        : await handleInference(
          request,
          env,
          config,
          client,
          matchedRoute.endpoint,
          requestId,
          context,
          {},
          requestLog,
        );
      return finish(response);
    } catch (error) {
      requestLog.error({
        outcome: "gateway_error",
        error: errorMessage(error),
      });
      return finish(openAiError(500, "The gateway failed to process the request", "server_error", "gateway_error"));
    }
  },
} satisfies ExportedHandler<Env>;
