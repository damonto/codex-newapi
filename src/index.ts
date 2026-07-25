import { ConfigError, loadConfig } from "./config.ts";
import { bearerToken, findClientApiKey, openAiError } from "./http.ts";
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

type InferencePath = "responses" | "chat/completions";

function route(pathname: string): "models" | InferencePath | undefined {
  switch (pathname) {
    case "/models":
    case "/v1/models":
      return "models";
    case "/responses":
    case "/v1/responses":
      return "responses";
    case "/chat/completions":
    case "/v1/chat/completions":
      return "chat/completions";
    default:
      return undefined;
  }
}

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    configureLogging(env.LOG_LEVEL);
    const startedAt = performance.now();
    const requestId = newRequestId();
    const incomingUrl = new URL(request.url);
    const endpoint = route(incomingUrl.pathname);
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
    if (endpoint === "models" && request.method !== "GET") {
      logWarn("request.method.rejected", {
        request_id: requestId,
        endpoint,
        method: request.method,
        expected_method: "GET",
      });
      return finish(openAiError(405, "Only GET is allowed for this endpoint"));
    }
    if (endpoint !== "models" && request.method !== "POST") {
      logWarn("request.method.rejected", {
        request_id: requestId,
        endpoint,
        method: request.method,
        expected_method: "POST",
      });
      return finish(openAiError(405, "Only POST is allowed for this endpoint"));
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
      const response = endpoint === "models"
        ? await handleModels(request, env, config, client, requestId, context)
        : await handleInference(request, env, config, client, endpoint, requestId, context);
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
