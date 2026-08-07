import { upstreamApiKeyValues } from "./credentials.ts";
import {
  clientApiKeyDigest,
  forwardableWebSocketHeaders,
  openAiError,
} from "./http.ts";
import type { RequestLogContext } from "./log.ts";
import {
  RESPONSES_WEBSOCKET_CLIENT_DIGEST_HEADER,
  RESPONSES_WEBSOCKET_REQUEST_ID_HEADER,
} from "./websocket-metadata.ts";
import type { ClientApiKeyConfig, GatewayConfig } from "./types.ts";

export async function handleResponsesWebSocket(
  request: Request,
  env: Env,
  initialConfig: GatewayConfig,
  initialClient: ClientApiKeyConfig,
  requestId: string,
  requestLog?: RequestLogContext,
): Promise<Response> {
  if (request.headers.has("sec-websocket-protocol")) {
    requestLog?.warn({ outcome: "websocket_subprotocol_unsupported" });
    return openAiError(
      400,
      "WebSocket subprotocols are not supported",
      "invalid_request_error",
      "websocket_subprotocol_unsupported",
    );
  }

  requestLog?.registerSensitiveValues([
    initialClient.api_key,
    ...upstreamApiKeyValues(initialConfig),
  ]);

  const headers = forwardableWebSocketHeaders(request);
  headers.set("upgrade", "websocket");
  headers.set(
    RESPONSES_WEBSOCKET_CLIENT_DIGEST_HEADER,
    await clientApiKeyDigest(initialClient.api_key),
  );
  headers.set(RESPONSES_WEBSOCKET_REQUEST_ID_HEADER, requestId);
  const proxyRequest = new Request(request, { headers });
  const proxyId = env.RESPONSES_WEBSOCKET.newUniqueId();
  const response = await env.RESPONSES_WEBSOCKET.get(proxyId).fetch(proxyRequest);
  if (response.status === 101 && response.webSocket) {
    requestLog?.set({ outcome: "websocket_accepted" });
  } else {
    requestLog?.warn({
      outcome: "websocket_proxy_rejected",
      upstream_status: response.status,
    });
  }
  return response;
}
