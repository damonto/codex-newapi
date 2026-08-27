import { BodyTooLargeError, readBodyWithinLimit } from "./body.ts";
import { jsonResponse, openAiError } from "./http.ts";
import { errorMessage, type RequestLogContext } from "./log.ts";
import { resolveModelRoute } from "./routing.ts";
import {
  executeSearchBatch,
  ProviderHttpError,
  ProviderInputError,
  ProviderNetworkError,
} from "./search-executor.ts";
import {
  parseSearchRequest,
  type ParsedSearchRequest,
  SearchRequestError,
} from "./search-request.ts";
import { codexOutput, codexResults } from "./search-response.ts";
import {
  ProviderProtocolError,
  webSearchProviderFor,
} from "./search-providers/index.ts";
import type { ClientApiKeyConfig, GatewayConfig } from "./types.ts";

export const MAX_SEARCH_BODY_BYTES = 1024 * 1024;

export async function handleConfiguredWebSearch(
  request: Request,
  config: GatewayConfig,
  client: ClientApiKeyConfig,
  requestLog?: RequestLogContext,
): Promise<Response> {
  const providerConfig = config.web_search;
  if (providerConfig.mode === "proxy") {
    throw new Error("configured web search handler cannot run in proxy mode");
  }
  const provider = webSearchProviderFor(providerConfig.mode);
  requestLog?.registerSensitiveValues([providerConfig.api_key]);

  let rawBody: Uint8Array<ArrayBuffer>;
  try {
    rawBody = await readBodyWithinLimit(
      request.body,
      MAX_SEARCH_BODY_BYTES,
      request.headers.get("content-length"),
    );
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      requestLog?.warn({
        outcome: "request_too_large",
        search: { max_body_bytes: MAX_SEARCH_BODY_BYTES },
      });
      return openAiError(
        413,
        `Search request body exceeds the ${MAX_SEARCH_BODY_BYTES}-byte limit`,
        "invalid_request_error",
        "request_too_large",
      );
    }
    throw error;
  }

  let parsedRequest: ParsedSearchRequest;
  try {
    parsedRequest = parseSearchRequest(new TextDecoder().decode(rawBody));
  } catch (error) {
    const requestError =
      error instanceof SearchRequestError ? error : undefined;
    requestLog?.warn({
      outcome: requestError?.kind ?? "invalid_search_request",
      error: errorMessage(error),
    });
    return openAiError(
      400,
      requestError?.message ?? "invalid search request",
      "invalid_request_error",
      requestError?.kind,
    );
  }

  const route = resolveModelRoute(config, client, parsedRequest.model);
  if (route.targets.length === 0) {
    requestLog?.warn({ outcome: "model_not_found" });
    return openAiError(
      400,
      `Model ${parsedRequest.model} is not available for this API key`,
      "invalid_request_error",
      "model_not_found",
    );
  }

  requestLog?.set({
    model: {
      requested: route.requestedModel,
      upstream: route.upstreamModel,
      route_applied: route.routeApplied,
    },
    search: {
      mode: providerConfig.mode,
      queries: parsedRequest.queries.length,
      ...(parsedRequest.responseLength === undefined
        ? {}
        : { response_length: parsedRequest.responseLength }),
    },
  });
  try {
    const results = await executeSearchBatch(
      provider,
      providerConfig,
      parsedRequest.queries,
      parsedRequest.filters,
      request.signal,
    );
    return jsonResponse({
      encrypted_output: null,
      output: codexOutput(parsedRequest.queries, results),
      results: codexResults(results),
    });
  } catch (error) {
    if (error instanceof ProviderInputError) {
      requestLog?.warn({
        outcome: "invalid_search_request",
        search: { mode: providerConfig.mode, error: error.message },
      });
      return openAiError(
        400,
        error.message,
        "invalid_request_error",
        "invalid_search_request",
      );
    }
    if (error instanceof ProviderHttpError) {
      requestLog?.warn({
        outcome: "web_search_upstream_error",
        upstream: { provider: providerConfig.mode, status: error.status },
      });
      return openAiError(
        error.status,
        `Configured ${providerConfig.mode} web search failed`,
        "server_error",
        "web_search_upstream_error",
      );
    }
    if (error instanceof ProviderProtocolError) {
      requestLog?.warn({
        outcome: "web_search_protocol_error",
        upstream: { provider: providerConfig.mode, error: errorMessage(error) },
      });
      return openAiError(
        502,
        "Configured web search provider returned an unusable response",
        "server_error",
        "web_search_invalid_response",
      );
    }
    requestLog?.warn({
      outcome: "web_search_unavailable",
      upstream: { provider: providerConfig.mode, error: errorMessage(error) },
    });
    return openAiError(
      502,
      error instanceof ProviderNetworkError
        ? "Configured web search provider could not be reached"
        : "Configured web search provider failed",
      "server_error",
      "web_search_unavailable",
    );
  }
}
