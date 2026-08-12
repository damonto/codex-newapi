import { ConfigError, loadConfig } from "./config.ts";
import {
  clearKeyHealth,
  clearServiceHealth,
  listCoolingHealth,
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
import { handleConfiguredWebSearch } from "./search.ts";
import {
  decodeSessionIdPath,
  handleSessionClearAll,
  handleSessionClearOne,
  handleSessionList,
} from "./session-bindings.ts";
import type { ClientApiKeyConfig, GatewayConfig } from "./types.ts";
import { handleResponsesWebSocket } from "./websocket.ts";

type GatewayEndpoint = "models" | "health" | "sessions" | InferencePath;

type GatewayRoute =
  | { endpoint: Exclude<GatewayEndpoint, "health" | "sessions"> }
  | { endpoint: "health"; action: "list" }
  | { endpoint: "health"; action: "clear"; serviceId: string; keyId?: string }
  | { endpoint: "sessions"; action: "collection" }
  | { endpoint: "sessions"; action: "clear"; encodedSessionId: string };

function route(pathname: string): GatewayRoute | undefined {
  const sessionMatch = pathname.match(/^\/(?:v1\/)?sessions\/(.*)$/);
  if (sessionMatch) {
    return {
      endpoint: "sessions",
      action: "clear",
      encodedSessionId: sessionMatch[1],
    };
  }
  const keyHealthMatch = pathname.match(
    /^\/(?:v1\/)?health\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/,
  );
  if (keyHealthMatch) {
    return {
      endpoint: "health",
      action: "clear",
      serviceId: keyHealthMatch[1],
      keyId: keyHealthMatch[2],
    };
  }
  const healthMatch = pathname.match(/^\/(?:v1\/)?health\/([A-Za-z0-9._-]+)$/);
  if (healthMatch) {
    return { endpoint: "health", action: "clear", serviceId: healthMatch[1] };
  }
  switch (pathname) {
    case "/health":
    case "/v1/health":
      return { endpoint: "health", action: "list" };
    case "/sessions":
    case "/v1/sessions":
      return { endpoint: "sessions", action: "collection" };
    case "/models":
    case "/v1/models":
      return { endpoint: "models" };
    case "/responses":
    case "/v1/responses":
      return { endpoint: "responses" };
    case "/responses/compact":
    case "/v1/responses/compact":
      return { endpoint: "responses/compact" };
    case "/alpha/search":
    case "/v1/alpha/search":
      return { endpoint: "alpha/search" };
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

function expectedMethods(route: GatewayRoute): readonly string[] {
  if (route.endpoint === "models" || (route.endpoint === "health" && route.action === "list")) {
    return ["GET"];
  }
  if (route.endpoint === "sessions") {
    return route.action === "collection" ? ["GET", "DELETE"] : ["DELETE"];
  }
  return route.endpoint === "health" ? ["DELETE"] : ["POST"];
}

async function handleHealthList(
  env: Env,
  config: GatewayConfig,
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
  const allowed = new Set(client.services);
  const services = config.services.filter((service) => allowed.has(service.id));
  const data = await listCoolingHealth(env, services, scope);
  requestLog.set({
    health: {
      action: "list",
      scope,
      cooling_services: data
        .filter((entry) => !("key_id" in entry))
        .map((entry) => entry.service_id),
      cooling_keys: data.flatMap((entry) =>
        "key_id" in entry
          ? [{ service_id: entry.service_id, key_id: entry.key_id }]
          : []
      ),
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
  config: GatewayConfig,
  client: ClientApiKeyConfig,
  incomingUrl: URL,
  serviceId: string,
  keyId: string | undefined,
  requestLog: RequestLogContext,
): Promise<Response> {
  const service = config.services.find((entry) => entry.id === serviceId);
  if (!service || !client.services.includes(serviceId)) {
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
  if (keyId !== undefined && !service.keys.some((key) => key.id === keyId)) {
    requestLog.warn({
      outcome: "key_not_found",
      health: { action: "clear", service_id: serviceId, key_id: keyId },
    });
    return openAiError(
      404,
      `Key ${keyId} is not available in service ${serviceId}`,
      "invalid_request_error",
      "key_not_found",
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
  const snapshot = keyId === undefined
    ? await clearServiceHealth(env, serviceId, scope)
    : await clearKeyHealth(env, serviceId, keyId, scope);
  requestLog.set({
    health: {
      action: "clear",
      service_id: serviceId,
      ...(keyId === undefined ? {} : { key_id: keyId }),
      scope,
      ...snapshot,
    },
  });
  return jsonResponse({
    service_id: serviceId,
    ...(keyId === undefined ? {} : { key_id: keyId }),
    scope,
    ...snapshot,
  });
}

async function handleSessions(
  request: Request,
  env: Env,
  client: ClientApiKeyConfig,
  incomingUrl: URL,
  matchedRoute: Extract<GatewayRoute, { endpoint: "sessions" }>,
  requestLog: RequestLogContext,
): Promise<Response> {
  if (matchedRoute.action === "collection") {
    return request.method === "GET"
      ? handleSessionList(env, client, incomingUrl, requestLog)
      : handleSessionClearAll(env, client, requestLog);
  }
  const sessionId = decodeSessionIdPath(matchedRoute.encodedSessionId);
  if (!sessionId) {
    requestLog.warn({
      outcome: "invalid_session_id",
      sessions: { action: "clear_one" },
    });
    return openAiError(
      400,
      "session_id must be a non-empty URL-encoded string",
      "invalid_request_error",
      "invalid_session_id",
    );
  }
  return handleSessionClearOne(env, client, sessionId, requestLog);
}

function isResponsesWebSocketRequest(
  request: Request,
  matchedRoute: GatewayRoute,
): boolean {
  return matchedRoute.endpoint === "responses" &&
    request.method === "GET" &&
    request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

async function handleMatchedRoute(
  request: Request,
  env: Env,
  config: GatewayConfig,
  client: ClientApiKeyConfig,
  incomingUrl: URL,
  matchedRoute: GatewayRoute,
  requestId: string,
  context: ExecutionContext,
  websocketRequest: boolean,
  requestLog: RequestLogContext,
): Promise<Response> {
  if (matchedRoute.endpoint === "models") {
    return handleModels(request, env, config, client, requestId, context, requestLog);
  }
  if (matchedRoute.endpoint === "health") {
    return matchedRoute.action === "list"
      ? handleHealthList(env, config, client, incomingUrl, requestLog)
      : handleHealthClear(
        env,
        config,
        client,
        incomingUrl,
        matchedRoute.serviceId,
        matchedRoute.keyId,
        requestLog,
      );
  }
  if (matchedRoute.endpoint === "sessions") {
    return handleSessions(request, env, client, incomingUrl, matchedRoute, requestLog);
  }
  if (matchedRoute.endpoint === "alpha/search" && config.web_search.mode !== "proxy") {
    return handleConfiguredWebSearch(request, config, client, requestLog);
  }
  if (websocketRequest) {
    return handleResponsesWebSocket(
      request,
      env,
      config,
      client,
      requestId,
      requestLog,
    );
  }
  return handleInference(
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
}

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    configureLogging(env.LOG_LEVEL);
    const requestId = newRequestId();
    const incomingUrl = new URL(request.url);
    const matchedRoute = route(incomingUrl.pathname);
    const endpoint = matchedRoute?.endpoint;
    const requestLog = new RequestLogContext(requestId, request, endpoint, context);
    if (matchedRoute?.endpoint === "sessions" && matchedRoute.action === "clear") {
      const prefix = incomingUrl.pathname.startsWith("/v1/")
        ? "/v1/sessions"
        : "/sessions";
      requestLog.set({ path: `${prefix}/{session_id}` });
    }
    const finish = (response: Response): Response => requestLog.complete(response);
    const clientToken = bearerToken(request);
    if (clientToken) {
      requestLog.registerSensitiveValues([clientToken]);
    }

    if (!endpoint) {
      requestLog.warn({ outcome: "route_not_found" });
      return finish(openAiError(404, "Not found", "invalid_request_error", "not_found"));
    }
    const websocketRequest = isResponsesWebSocketRequest(request, matchedRoute);
    const allowedMethods = expectedMethods(matchedRoute);
    if (!websocketRequest && !allowedMethods.includes(request.method)) {
      requestLog.warn({
        outcome: "method_rejected",
        expected_methods: allowedMethods,
      });
      return finish(openAiError(
        405,
        `Only ${allowedMethods.join(" or ")} is allowed for this endpoint`,
      ));
    }

    let config;
    try {
      config = await loadConfig(env, requestLog);
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
      client_key_id: client.id,
      allowed_services: [...client.services],
    });

    try {
      const response = await handleMatchedRoute(
        request,
        env,
        config,
        client,
        incomingUrl,
        matchedRoute,
        requestId,
        context,
        websocketRequest,
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
