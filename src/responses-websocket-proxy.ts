import { DurableObject } from "cloudflare:workers";

import { loadConfig } from "./config.ts";
import {
  isHealthFailureStatus,
  isKeyHealthFailureStatus,
  recordKeyFailure,
  recordServiceFailure,
  recordServiceSuccess,
} from "./health.ts";
import {
  findClientApiKeyByDigest,
  forwardableWebSocketHeaders,
  upstreamUrl,
} from "./http.ts";
import {
  bounded,
  configureLogging,
  errorMessage,
  logError,
  logInfo,
  logWarn,
} from "./log.ts";
import {
  fetchWithConfiguredRetries,
  UpstreamAttemptTimeoutError,
} from "./proxy.ts";
import {
  resolveModelRoute,
  selectAvailableServiceWithDetails,
  targetIsAvailableForRoute,
  type ModelRoute,
  type ServiceTarget,
} from "./routing.ts";
import type { ClientApiKeyConfig, GatewayConfig } from "./types.ts";
import {
  clientFrame,
  closeSocket,
  errorStatus,
  gatewayErrorEvent,
  messageBytes,
  nonEmptyString,
  normalizeMessage,
  parseObject,
  rewriteResponseCreate,
  safeSend,
  upstreamErrorText,
  type ResponseCreateFrame,
  type WebSocketMessage,
} from "./websocket-protocol.ts";
import {
  RESPONSES_WEBSOCKET_CLIENT_DIGEST_HEADER,
  RESPONSES_WEBSOCKET_REQUEST_ID_HEADER,
} from "./websocket-metadata.ts";

const FIRST_FRAME_TIMEOUT_MS = 10_000;
const UPSTREAM_HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_PENDING_WEBSOCKET_BYTES = 32 * 1024 * 1024;
const SESSION_STATE_KEY = "session";

type SessionPhase =
  | "awaiting_first_frame"
  | "routing"
  | "connecting"
  | "open"
  | "closed";
type SocketRole = "client" | "upstream";

interface SocketAttachment {
  role: SocketRole;
}

interface StoredWebSocketSession {
  version: 1;
  phase: SessionPhase;
  request_id: string;
  started_at: number;
  first_frame_deadline: number;
  incoming_search: string;
  forwarded_headers: [string, string][];
  client_api_key_digest: string;
  header_session_id?: string;
  current_session_id?: string;
  selected_service_id?: string;
  selected_key_id?: string;
  active_response: boolean;
  response_outcome_recorded: boolean;
}

interface StateTransition {
  previous: StoredWebSocketSession;
  next: StoredWebSocketSession;
}

interface CurrentRoutingContext {
  config: GatewayConfig;
  client: ClientApiKeyConfig;
}

const LIVE_PHASES: readonly SessionPhase[] = [
  "awaiting_first_frame",
  "routing",
  "connecting",
  "open",
];

function isSocketRole(value: unknown): value is SocketRole {
  return value === "client" || value === "upstream";
}

function socketAttachment(value: unknown): SocketAttachment | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const role = Reflect.get(value, "role");
  return isSocketRole(role) ? { role } : undefined;
}

function requestIdFrom(request: Request): string | undefined {
  return nonEmptyString(
    request.headers.get(RESPONSES_WEBSOCKET_REQUEST_ID_HEADER),
  );
}

function clientDigestFrom(request: Request): string | undefined {
  const digest = request.headers.get(RESPONSES_WEBSOCKET_CLIENT_DIGEST_HEADER);
  return digest && /^[a-f0-9]{64}$/i.test(digest) ? digest.toLowerCase() : undefined;
}

function targetFromRoute(
  route: ModelRoute,
  state: StoredWebSocketSession,
): ServiceTarget | undefined {
  const routed = route.targets.find(({ service }) =>
    service.id === state.selected_service_id
  );
  const key = routed?.keys.find((entry) => entry.id === state.selected_key_id);
  return routed && key ? { service: routed.service, key } : undefined;
}

function shouldRecordUpstreamFailure(
  state: StoredWebSocketSession | undefined,
): boolean {
  return state !== undefined &&
    !state.response_outcome_recorded &&
    (state.phase === "connecting" ||
      (state.phase === "open" && state.active_response));
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new DOMException("aborted", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class ResponsesWebSocketProxy extends DurableObject<Env> {
  private pendingClientBytes = 0;
  private clientMessages = Promise.resolve();
  private upstreamEvents = Promise.resolve();
  private upstreamController?: AbortController;
  private liveUpstreamSocket?: WebSocket;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    configureLogging(this.env.LOG_LEVEL);
  }

  async fetch(request: Request): Promise<Response> {
    if (
      request.method !== "GET" ||
      request.headers.get("upgrade")?.toLowerCase() !== "websocket"
    ) {
      return new Response("Expected a WebSocket upgrade", { status: 400 });
    }
    const requestId = requestIdFrom(request);
    const clientDigest = clientDigestFrom(request);
    if (!requestId || !clientDigest) {
      return new Response("Missing internal WebSocket metadata", { status: 400 });
    }
    if (await this.ctx.storage.get(SESSION_STATE_KEY) !== undefined) {
      return new Response("WebSocket session already exists", { status: 409 });
    }

    const forwardedHeaders = forwardableWebSocketHeaders(request);
    const state: StoredWebSocketSession = {
      version: 1,
      phase: "awaiting_first_frame",
      request_id: requestId,
      started_at: Date.now(),
      first_frame_deadline: Date.now() + FIRST_FRAME_TIMEOUT_MS,
      incoming_search: new URL(request.url).search,
      forwarded_headers: [...forwardedHeaders.entries()],
      client_api_key_digest: clientDigest,
      ...(nonEmptyString(request.headers.get("session-id"))
        ? { header_session_id: nonEmptyString(request.headers.get("session-id")) }
        : {}),
      active_response: false,
      response_outcome_recorded: false,
    };
    await this.ctx.storage.put(SESSION_STATE_KEY, state);
    await this.ctx.storage.setAlarm(state.first_frame_deadline);

    const pair = new WebSocketPair();
    try {
      this.ctx.acceptWebSocket(pair[1], ["client"]);
      pair[1].serializeAttachment({ role: "client" } satisfies SocketAttachment);
    } catch (error) {
      await Promise.all([
        this.ctx.storage.delete(SESSION_STATE_KEY),
        this.ctx.storage.deleteAlarm(),
      ]);
      logError("websocket.accept.failed", {
        request_id: requestId,
        error: errorMessage(error),
      });
      throw error;
    }
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async alarm(): Promise<void> {
    const state = await this.loadState();
    if (state?.phase !== "awaiting_first_frame") {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    if (state.first_frame_deadline > Date.now()) {
      await this.ctx.storage.setAlarm(state.first_frame_deadline);
      return;
    }
    await this.closeAll(
      1008,
      "response.create timeout",
      "first_frame_timeout",
      ["awaiting_first_frame"],
      gatewayErrorEvent(
        408,
        "A response.create frame was not received in time",
        "websocket_first_frame_timeout",
      ),
    );
  }

  private loadState(): Promise<StoredWebSocketSession | undefined> {
    return this.ctx.storage.get<StoredWebSocketSession>(SESSION_STATE_KEY);
  }

  private transition(
    expectedPhases: readonly SessionPhase[],
    mutate: (state: StoredWebSocketSession) => StoredWebSocketSession,
  ): Promise<StateTransition | undefined> {
    return this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<StoredWebSocketSession>(
        SESSION_STATE_KEY,
      );
      if (!current || !expectedPhases.includes(current.phase)) {
        return undefined;
      }
      const next = mutate(current);
      if (current.phase === "closed" && next.phase !== "closed") {
        return undefined;
      }
      await transaction.put(SESSION_STATE_KEY, next);
      return { previous: current, next };
    });
  }

  private socketRole(socket: WebSocket): SocketRole | undefined {
    const attachment = socketAttachment(socket.deserializeAttachment());
    if (attachment) {
      return attachment.role;
    }
    return this.ctx.getTags(socket).find(isSocketRole);
  }

  private clientSocket(): WebSocket | undefined {
    return this.ctx.getWebSockets("client")[0];
  }

  private upstreamSocket(): WebSocket | undefined {
    return this.liveUpstreamSocket;
  }

  private async closeAll(
    code: number,
    reason: string,
    outcome: string,
    expectedPhases: readonly SessionPhase[] = LIVE_PHASES,
    clientMessage?: WebSocketMessage,
  ): Promise<void> {
    const transition = await this.transition(expectedPhases, (state) => ({
      ...state,
      phase: "closed",
    }));
    if (!transition) {
      return;
    }

    if (clientMessage !== undefined) {
      safeSend(this.clientSocket(), clientMessage);
    }
    this.upstreamController?.abort();
    this.upstreamController = undefined;
    closeSocket(this.upstreamSocket(), code, reason);
    this.liveUpstreamSocket = undefined;
    closeSocket(this.clientSocket(), code, reason);

    const state = transition.previous;
    const fields = {
      request_id: state.request_id,
      outcome,
      close_code: code,
      phase: state.phase,
      active_response: state.active_response,
      duration_ms: Math.max(0, Date.now() - state.started_at),
      ...(state.selected_service_id && state.selected_key_id
        ? {
          service_id: state.selected_service_id,
          key_id: state.selected_key_id,
        }
        : {}),
    };
    if (code === 1000 && (outcome === "client_closed" || outcome === "upstream_closed")) {
      logInfo("websocket.closed", fields);
    } else {
      logWarn("websocket.closed", fields);
    }

    // Every connection gets a unique object ID. Once both sockets are closing,
    // no future request can legitimately reuse this state.
    await Promise.all([
      this.ctx.storage.delete(SESSION_STATE_KEY),
      this.ctx.storage.deleteAlarm(),
    ]);
  }

  private async currentRoutingContext(
    state: StoredWebSocketSession,
  ): Promise<CurrentRoutingContext | undefined> {
    let config: GatewayConfig;
    let client: ClientApiKeyConfig | undefined;
    try {
      config = await loadConfig(this.env, state.request_id);
      client = await findClientApiKeyByDigest(
        state.client_api_key_digest,
        config.api_keys,
      );
    } catch (error) {
      logWarn("websocket.configuration_refresh.failed", {
        request_id: state.request_id,
        error: errorMessage(error),
      });
      safeSend(
        this.clientSocket(),
        gatewayErrorEvent(
          503,
          "The gateway configuration is temporarily unavailable; reconnect the WebSocket",
          "configuration_unavailable",
        ),
      );
      await this.closeAll(
        1012,
        "gateway configuration unavailable",
        "configuration_unavailable",
      );
      return undefined;
    }

    if (!client) {
      logWarn("websocket.authentication_revoked", {
        request_id: state.request_id,
      });
      safeSend(
        this.clientSocket(),
        gatewayErrorEvent(
          401,
          "The client API key is no longer valid",
          "invalid_api_key",
        ),
      );
      await this.closeAll(
        1008,
        "client authentication is no longer valid",
        "authentication_revoked",
      );
      return undefined;
    }
    return { config, client };
  }

  private async recordServiceFailureOnce(): Promise<void> {
    const transition = await this.transition(
      ["connecting", "open"],
      (state) => state.response_outcome_recorded
        ? state
        : { ...state, response_outcome_recorded: true },
    );
    if (
      !transition ||
      transition.previous.response_outcome_recorded ||
      !transition.next.selected_service_id
    ) {
      return;
    }
    await recordServiceFailure(
      this.env,
      transition.next.selected_service_id,
      transition.next.request_id,
    );
  }

  private async recordCompletedResponse(): Promise<void> {
    const transition = await this.transition(["open"], (state) => ({
      ...state,
      active_response: false,
      response_outcome_recorded: true,
    }));
    if (
      !transition ||
      transition.previous.response_outcome_recorded ||
      !transition.next.selected_service_id
    ) {
      return;
    }
    await recordServiceSuccess(
      this.env,
      transition.next.selected_service_id,
      transition.next.request_id,
    );
  }

  private async markResponseInactive(): Promise<void> {
    await this.transition(["open"], (state) => ({
      ...state,
      active_response: false,
    }));
  }

  private async processUpstreamMessage(message: WebSocketMessage): Promise<void> {
    const state = await this.loadState();
    if (state?.phase !== "open") {
      return;
    }
    const payload = typeof message === "string" ? parseObject(message) : undefined;
    const status = payload ? errorStatus(payload) : undefined;
    if (
      status !== undefined &&
      isKeyHealthFailureStatus(status) &&
      state.selected_service_id &&
      state.selected_key_id
    ) {
      await recordKeyFailure(
        this.env,
        state.selected_service_id,
        state.selected_key_id,
        state.request_id,
      );
    }
    if (status !== undefined && isHealthFailureStatus(status)) {
      await this.recordServiceFailureOnce();
    }

    if (!safeSend(this.clientSocket(), message)) {
      await this.closeAll(
        1011,
        "client websocket unavailable",
        "client_socket_unavailable",
      );
      return;
    }
    if (!payload) {
      return;
    }

    if (payload.type === "response.completed") {
      await this.recordCompletedResponse();
      return;
    }
    if (payload.type === "response.failed" || payload.type === "response.incomplete") {
      await this.markResponseInactive();
      return;
    }
    if (payload.type === "error") {
      await this.markResponseInactive();
      await this.closeAll(
        1011,
        status !== undefined && isKeyHealthFailureStatus(status)
          ? "selected upstream key is cooling down"
          : "upstream returned an error",
        status !== undefined && isKeyHealthFailureStatus(status)
          ? "key_cooling_down"
          : "upstream_error",
      );
    }
  }

  private enqueueUpstreamEvent(
    event: "message" | "close" | "error",
    operation: () => Promise<void>,
  ): void {
    const processing = this.upstreamEvents.then(operation);
    this.upstreamEvents = processing.catch(async (error) => {
      logError("websocket.upstream_event.failed", {
        upstream_event: event,
        error: errorMessage(error),
      });
      await this.closeAll(
        1011,
        "upstream event processing failed",
        "upstream_event_processing_failed",
      );
    });
    this.ctx.waitUntil(this.upstreamEvents);
  }

  private attachUpstream(socket: WebSocket): void {
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", (event) => {
      this.enqueueUpstreamEvent("message", async () => {
        const message = await normalizeMessage(event.data);
        if (message !== undefined) {
          await this.processUpstreamMessage(message);
        }
      });
    });
    socket.addEventListener("close", (event) => {
      this.enqueueUpstreamEvent("close", () => this.handleUpstreamClose(event));
    });
    socket.addEventListener("error", () => {
      this.enqueueUpstreamEvent("error", () => this.handleUpstreamError());
    });

    // Cloudflare only supports hibernation when the Durable Object is the
    // WebSocket server. Outgoing WebSockets use the standard API and keep the
    // object active while connected.
    socket.accept({ allowHalfOpen: true });
    this.liveUpstreamSocket = socket;
  }

  private async handleUpstreamClose(event: CloseEvent): Promise<void> {
    const state = await this.loadState();
    const upstreamFailed = shouldRecordUpstreamFailure(state);
    if (upstreamFailed) {
      await this.recordServiceFailureOnce();
    }
    const outcome = state?.phase === "connecting" && upstreamFailed
      ? "upstream_closed_during_connect"
      : upstreamFailed
      ? "upstream_closed_during_response"
      : "upstream_closed";
    await this.closeAll(
      event.code,
      event.reason || "upstream websocket closed",
      outcome,
    );
  }

  private async handleUpstreamError(): Promise<void> {
    const state = await this.loadState();
    if (shouldRecordUpstreamFailure(state)) {
      await this.recordServiceFailureOnce();
    }
    await this.closeAll(1011, "upstream websocket error", "upstream_socket_error");
  }

  private async connectUpstream(
    originalMessage: string,
    frame: ResponseCreateFrame,
    route: ModelRoute,
    target: ServiceTarget,
    sessionId: string | undefined,
  ): Promise<void> {
    const connecting = await this.transition(
      ["routing"],
      (state) => ({
        ...state,
        phase: "connecting",
        ...(sessionId ? { current_session_id: sessionId } : {}),
        selected_service_id: target.service.id,
        selected_key_id: target.key.id,
      }),
    );
    if (!connecting) {
      return;
    }

    const controller = new AbortController();
    this.upstreamController = controller;
    const headers = new Headers(connecting.next.forwarded_headers);
    headers.set("authorization", `Bearer ${target.key.api_key}`);
    headers.set("upgrade", "websocket");
    const result = await fetchWithConfiguredRetries(
      () => new Request(
        upstreamUrl(target.service, "responses", connecting.next.incoming_search),
        {
          method: "GET",
          headers,
          redirect: "manual",
          signal: controller.signal,
        },
      ),
      target.service.retry,
      {
        wait: (delayMs) => abortableDelay(delayMs, controller.signal),
        attemptTimeoutMs: UPSTREAM_HANDSHAKE_TIMEOUT_MS,
        onResponse: async (response) => {
          if (isKeyHealthFailureStatus(response.status)) {
            await recordKeyFailure(
              this.env,
              target.service.id,
              target.key.id,
              connecting.next.request_id,
            );
          }
        },
      },
    );
    if (this.upstreamController === controller) {
      this.upstreamController = undefined;
    }

    const current = await this.loadState();
    if (current?.phase !== "connecting") {
      closeSocket(result.response?.webSocket ?? undefined, 1000, "client disconnected");
      return;
    }
    if (!result.response) {
      const timedOut = result.error instanceof UpstreamAttemptTimeoutError;
      await this.recordServiceFailureOnce();
      safeSend(
        this.clientSocket(),
        gatewayErrorEvent(
          timedOut ? 504 : 502,
          timedOut
            ? "The selected upstream WebSocket handshake timed out"
            : "The selected upstream WebSocket could not be reached",
          timedOut ? "upstream_handshake_timeout" : "upstream_unavailable",
        ),
      );
      logWarn(
        timedOut
          ? "websocket.upstream_handshake_timeout"
          : "websocket.upstream_unavailable",
        {
          request_id: current.request_id,
          service_id: target.service.id,
          key_id: target.key.id,
          attempts: result.attempts,
          error: errorMessage(result.error),
        },
      );
      await this.closeAll(
        1011,
        timedOut
          ? "upstream websocket handshake timed out"
          : "upstream websocket unavailable",
        timedOut ? "upstream_handshake_timeout" : "upstream_unavailable",
      );
      return;
    }

    const response = result.response;
    const socket = response.webSocket;
    if (response.status !== 101 || !socket) {
      if (isHealthFailureStatus(response.status)) {
        await this.recordServiceFailureOnce();
      }
      const body = await upstreamErrorText(response);
      safeSend(
        this.clientSocket(),
        body ?? gatewayErrorEvent(
          response.status || 502,
          `Upstream WebSocket upgrade failed with status ${response.status}`,
          "websocket_upgrade_failed",
        ),
      );
      logWarn("websocket.upgrade_rejected", {
        request_id: current.request_id,
        service_id: target.service.id,
        key_id: target.key.id,
        status: response.status,
        attempts: result.attempts,
      });
      await this.closeAll(
        1011,
        "upstream websocket upgrade failed",
        "upstream_upgrade_failed",
      );
      return;
    }

    try {
      this.attachUpstream(socket);
    } catch (error) {
      closeSocket(socket, 1011, "upstream websocket acceptance failed");
      await this.recordServiceFailureOnce();
      logWarn("websocket.upstream_accept.failed", {
        request_id: current.request_id,
        service_id: target.service.id,
        key_id: target.key.id,
        error: errorMessage(error),
      });
      await this.closeAll(
        1011,
        "upstream websocket unavailable",
        "upstream_socket_unavailable",
      );
      return;
    }

    const opened = await this.transition(["connecting"], (state) => ({
      ...state,
      phase: "open",
      active_response: true,
      response_outcome_recorded: false,
    }));
    if (!opened) {
      if (this.liveUpstreamSocket === socket) {
        this.liveUpstreamSocket = undefined;
      }
      closeSocket(socket, 1000, "client disconnected");
      return;
    }
    const rewritten = rewriteResponseCreate(
      originalMessage,
      frame,
      route.upstreamModel,
    );
    if (!safeSend(socket, rewritten)) {
      await this.recordServiceFailureOnce();
      await this.closeAll(
        1011,
        "upstream websocket unavailable",
        "upstream_socket_unavailable",
      );
      return;
    }
    logInfo("websocket.connected", {
      request_id: opened.next.request_id,
      service_id: target.service.id,
      key_id: target.key.id,
      model: bounded(route.upstreamModel, 160),
      model_rewritten: frame.model !== route.upstreamModel,
      attempts: result.attempts,
    });
  }

  private async validateCurrentTarget(
    state: StoredWebSocketSession,
    route: ModelRoute,
    sessionId: string | undefined,
    client: ClientApiKeyConfig,
  ): Promise<boolean> {
    const selectedTarget = targetFromRoute(route, state);
    if (!selectedTarget) {
      return false;
    }
    if (!sessionId) {
      return targetIsAvailableForRoute(this.env, route, selectedTarget);
    }
    const selection = await selectAvailableServiceWithDetails(this.env, route, {
      session: { clientApiKey: client.api_key, sessionId },
    });
    if (selection.affinity?.status === "failed") {
      logWarn("websocket.affinity.failed", {
        request_id: state.request_id,
        error: selection.affinity.error,
      });
      return targetIsAvailableForRoute(this.env, route, selectedTarget);
    }
    return selection.target?.service.id === selectedTarget.service.id &&
      selection.target.key.id === selectedTarget.key.id;
  }

  private async processFirstFrame(message: WebSocketMessage): Promise<void> {
    if (typeof message !== "string") {
      safeSend(
        this.clientSocket(),
        gatewayErrorEvent(
          400,
          "The first WebSocket message must be a response.create JSON text frame",
          "invalid_websocket_first_frame",
        ),
      );
      await this.closeAll(1008, "invalid first websocket frame", "invalid_first_frame");
      return;
    }
    const parsedFrame = clientFrame(message);
    if (parsedFrame.kind !== "response_create") {
      safeSend(
        this.clientSocket(),
        gatewayErrorEvent(
          400,
          "The first WebSocket message must contain response.create and a model",
          "invalid_websocket_first_frame",
        ),
      );
      await this.closeAll(1008, "invalid first websocket frame", "invalid_first_frame");
      return;
    }

    const claimed = await this.transition(["awaiting_first_frame"], (latest) => ({
      ...latest,
      phase: "routing",
    }));
    if (!claimed) {
      return;
    }
    await this.ctx.storage.deleteAlarm();
    if ((await this.loadState())?.phase !== "routing") {
      return;
    }

    const routingContext = await this.currentRoutingContext(claimed.next);
    if (!routingContext || (await this.loadState())?.phase !== "routing") {
      return;
    }
    const frame = parsedFrame.frame;
    const route = resolveModelRoute(
      routingContext.config,
      routingContext.client,
      frame.model,
      { requiredCapability: "supports_websocket" },
    );
    if (route.targets.length === 0) {
      safeSend(
        this.clientSocket(),
        gatewayErrorEvent(
          400,
          `Model ${frame.model} is not available for this API key`,
          "model_not_found",
        ),
      );
      await this.closeAll(1008, "model unavailable", "model_unavailable");
      return;
    }

    const sessionId = claimed.next.header_session_id ?? frame.sessionId;
    const selection = await selectAvailableServiceWithDetails(this.env, route, {
      ...(sessionId
        ? {
          session: {
            clientApiKey: routingContext.client.api_key,
            sessionId,
          },
        }
        : {}),
    });
    if (selection.affinity?.status === "failed") {
      logWarn("websocket.affinity.failed", {
        request_id: claimed.next.request_id,
        error: selection.affinity.error,
      });
    }
    if (!selection.target) {
      safeSend(
        this.clientSocket(),
        gatewayErrorEvent(
          503,
          `No healthy service is currently available for model ${frame.model}`,
          "service_cooling_down",
        ),
      );
      await this.closeAll(
        1013,
        "no healthy upstream service",
        "no_healthy_upstream",
      );
      return;
    }
    await this.connectUpstream(
      message,
      frame,
      route,
      selection.target,
      sessionId,
    );
  }

  private async processOpenMessage(
    state: StoredWebSocketSession,
    message: WebSocketMessage,
  ): Promise<void> {
    if (typeof message === "string") {
      const parsedFrame = clientFrame(message);
      if (parsedFrame.kind === "invalid_response_create") {
        safeSend(
          this.clientSocket(),
          gatewayErrorEvent(
            400,
            "Every response.create frame must contain a non-empty model string",
            "invalid_websocket_response_create",
          ),
        );
        await this.closeAll(
          1008,
          "invalid response.create frame",
          "invalid_response_create",
        );
        return;
      }
      if (parsedFrame.kind === "response_create") {
        const routingContext = await this.currentRoutingContext(state);
        if (!routingContext) {
          return;
        }
        const current = await this.loadState();
        if (current?.phase !== "open") {
          return;
        }
        const frame = parsedFrame.frame;
        const route = resolveModelRoute(
          routingContext.config,
          routingContext.client,
          frame.model,
          { requiredCapability: "supports_websocket" },
        );
        const sessionId = current.header_session_id ??
          frame.sessionId ??
          current.current_session_id;
        if (
          route.targets.length === 0 ||
          !await this.validateCurrentTarget(
            current,
            route,
            sessionId,
            routingContext.client,
          )
        ) {
          safeSend(
            this.clientSocket(),
            gatewayErrorEvent(
              503,
              "The bound upstream service or key is no longer available; reconnect the WebSocket",
              "websocket_reconnect_required",
            ),
          );
          await this.closeAll(
            1012,
            "upstream binding changed",
            "binding_changed",
          );
          return;
        }
        const activated = await this.transition(["open"], (latest) => ({
          ...latest,
          ...(sessionId ? { current_session_id: sessionId } : {}),
          active_response: true,
          response_outcome_recorded: false,
        }));
        const upstream = this.upstreamSocket();
        if (
          !activated ||
          !safeSend(
            upstream,
            rewriteResponseCreate(message, frame, route.upstreamModel),
          )
        ) {
          await this.recordServiceFailureOnce();
          await this.closeAll(
            1011,
            "upstream websocket unavailable",
            "upstream_socket_unavailable",
          );
        }
        return;
      }
    }

    if (!safeSend(this.upstreamSocket(), message)) {
      await this.recordServiceFailureOnce();
      await this.closeAll(
        1011,
        "upstream websocket unavailable",
        "upstream_socket_unavailable",
      );
    }
  }

  private async processClientMessage(message: WebSocketMessage): Promise<void> {
    const state = await this.loadState();
    if (!state || state.phase === "closed") {
      return;
    }
    if (state.phase === "awaiting_first_frame") {
      await this.processFirstFrame(message);
      return;
    }
    if (state.phase === "open") {
      await this.processOpenMessage(state, message);
    }
  }

  private enqueueClientMessage(message: WebSocketMessage): Promise<void> {
    const bytes = messageBytes(message);
    this.pendingClientBytes += bytes;
    if (this.pendingClientBytes > MAX_PENDING_WEBSOCKET_BYTES) {
      safeSend(
        this.clientSocket(),
        gatewayErrorEvent(
          413,
          "Pending WebSocket messages exceed 32 MiB",
          "websocket_queue_too_large",
        ),
      );
      return this.closeAll(
        1009,
        "pending websocket messages too large",
        "client_queue_too_large",
      );
    }

    const processing = this.clientMessages.then(async () => {
      this.pendingClientBytes -= bytes;
      await this.processClientMessage(message);
    });
    this.clientMessages = processing.catch(async (error) => {
      logError("websocket.client_message.failed", {
        error: errorMessage(error),
      });
      await this.closeAll(
        1011,
        "client message processing failed",
        "client_message_processing_failed",
      );
    });
    return this.clientMessages;
  }

  webSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer,
  ): void {
    const role = this.socketRole(socket);
    if (role === "client") {
      this.ctx.waitUntil(this.enqueueClientMessage(message));
      return;
    }
    this.ctx.waitUntil(
      this.closeAll(1011, "unknown websocket peer", "unknown_socket_role"),
    );
  }

  async webSocketClose(
    socket: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    const role = this.socketRole(socket);
    await this.closeAll(
      code,
      reason || `${role ?? "unknown"} websocket closed`,
      role === "client"
        ? code === 1000 ? "client_closed" : "client_closed_abnormally"
        : "unknown_socket_closed",
    );
  }

  async webSocketError(socket: WebSocket, error: unknown): Promise<void> {
    const role = this.socketRole(socket);
    const state = await this.loadState();
    logWarn("websocket.socket_error", {
      request_id: state?.request_id,
      role,
      error: errorMessage(error),
    });
    await this.closeAll(
      1011,
      `${role ?? "unknown"} websocket error`,
      role === "client" ? "client_socket_error" : "unknown_socket_error",
    );
  }
}
