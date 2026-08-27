const CLAUDE_AGENT_SDK_MARKER =
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const CLAUDE_CODE_BETA = "claude-code-20250219";
const CLAUDE_CLI_USER_AGENT = "claude-cli/2.1.246 (external, sdk-cli)";
const CLAUDE_CODE_X_APP = "cli";

interface ClaudeCodeUserMetadata {
  device_id?: string;
  session_id?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textBlockHasAgentMarker(entry: unknown): boolean {
  if (!isRecord(entry)) {
    return false;
  }
  const text = entry.text;
  return typeof text === "string" && text.includes(CLAUDE_AGENT_SDK_MARKER);
}

function hasAgentMarker(system: unknown): boolean {
  if (typeof system === "string") {
    return system.includes(CLAUDE_AGENT_SDK_MARKER);
  }
  return Array.isArray(system) && system.some(textBlockHasAgentMarker);
}

function ensureSystemMarker(payload: Record<string, unknown>): boolean {
  if (hasAgentMarker(payload.system)) {
    return false;
  }
  const markerBlock = { type: "text", text: CLAUDE_AGENT_SDK_MARKER };
  if (Array.isArray(payload.system)) {
    payload.system = [markerBlock, ...payload.system];
  } else if (typeof payload.system === "string") {
    payload.system = [markerBlock, { type: "text", text: payload.system }];
  } else {
    payload.system = [markerBlock];
  }
  return true;
}

function ensureUserId(metadata: Record<string, unknown>): boolean {
  let changed = false;
  let userMetadata: ClaudeCodeUserMetadata = {};
  if (typeof metadata.user_id === "string") {
    try {
      const parsed = JSON.parse(metadata.user_id) as unknown;
      if (isRecord(parsed)) {
        userMetadata = parsed;
      }
    } catch {
      // Replace the malformed identity with a fresh one below.
    }
  } else if (isRecord(metadata.user_id)) {
    userMetadata = metadata.user_id;
  }
  if (
    typeof userMetadata.device_id !== "string" ||
    userMetadata.device_id.trim() === ""
  ) {
    userMetadata.device_id = crypto.randomUUID();
    changed = true;
  }
  if (
    typeof userMetadata.session_id !== "string" ||
    userMetadata.session_id.trim() === ""
  ) {
    userMetadata.session_id = crypto.randomUUID();
    changed = true;
  }
  const serializedUserId = JSON.stringify(userMetadata);
  if (metadata.user_id !== serializedUserId) {
    metadata.user_id = serializedUserId;
    changed = true;
  }
  return changed;
}

/**
 * Injects the Claude Code SDK client identity into an Anthropic /v1/messages
 * request body so gateways that only accept Claude Code clients let it through.
 * Returns whether the payload was modified.
 */
export function injectClaudeCodeIdentity(
  payload: Record<string, unknown>,
): boolean {
  const systemChanged = ensureSystemMarker(payload);
  const metadata = isRecord(payload.metadata) ? payload.metadata : {};
  const metadataChanged = ensureUserId(metadata);
  if (!isRecord(payload.metadata)) {
    payload.metadata = metadata;
  }
  return systemChanged || metadataChanged;
}

/**
 * Adds the Claude Code client headers required by upstream gateways:
 * the SDK beta token, the CLI user agent, and the CLI app marker.
 */
export function applyClaudeCodeIdentityHeaders(headers: Headers): void {
  const betaParts = (headers.get("anthropic-beta") ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (!betaParts.includes(CLAUDE_CODE_BETA)) {
    betaParts.unshift(CLAUDE_CODE_BETA);
    headers.set("anthropic-beta", betaParts.join(","));
  }
  headers.set("user-agent", CLAUDE_CLI_USER_AGENT);
  headers.set("x-app", CLAUDE_CODE_X_APP);
}
