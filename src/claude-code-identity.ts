const CLAUDE_AGENT_SDK_MARKER =
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const CLAUDE_CODE_BETA = "claude-code-20250219";
const CLAUDE_CLI_USER_AGENT = "claude-cli/2.1.246 (external, sdk-cli)";
const CLAUDE_CODE_X_APP = "cli";
// Recognizes a user agent the client already sent as a Claude CLI one, so a
// newer real client is not downgraded to the pinned constant above.
const CLAUDE_CLI_USER_AGENT_PATTERN = /^claude-cli\//i;

/** Stable per-client identity injected into Anthropic request metadata. */
export interface ClaudeCodeIdentity {
  deviceId: string;
  sessionId: string;
}

export interface InjectClaudeCodeIdentityOptions {
  /**
   * Whether the target endpoint accepts a top-level `metadata` field.
   * `/v1/messages` does; `/v1/messages/count_tokens` rejects unknown fields,
   * so only the `system` marker is injected there.
   */
  includeMetadata: boolean;
}

interface ClaudeCodeUserMetadata {
  device_id?: string;
  session_id?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Derives a UUID-shaped identifier from `parts` with SHA-256. Claude Code sends
 * real UUIDs, so the upstream shape is preserved while the value stays stable
 * for the same inputs instead of churning on every request.
 */
async function derivedUuid(...parts: string[]): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(parts.join("\u0000")),
  );
  const bytes = new Uint8Array(digest).subarray(0, 16);
  // Version 8 (RFC 9562, name-derived) plus the RFC 4122 variant bits, so the
  // value parses as a UUID without claiming the randomness that version 4
  // would assert for what is a deterministic digest.
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const text = hex(bytes);
  return [
    text.slice(0, 8),
    text.slice(8, 12),
    text.slice(12, 16),
    text.slice(16, 20),
    text.slice(20, 32),
  ].join("-");
}

/**
 * Builds the Claude Code identity for one request. The device is stable per
 * client API key and the session is stable per gateway session, so an upstream
 * gateway sees one device continuing one conversation rather than a new device
 * on every turn. Requests without a session identifier fall back to a
 * per-client session, which is still stable across turns.
 */
export async function claudeCodeIdentityFor(
  clientApiKey: string,
  sessionId?: string,
): Promise<ClaudeCodeIdentity> {
  const [deviceId, derivedSessionId] = await Promise.all([
    derivedUuid("cody.claude-code.device", clientApiKey),
    derivedUuid("cody.claude-code.session", clientApiKey, sessionId ?? ""),
  ]);
  return { deviceId, sessionId: derivedSessionId };
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

function ensureUserId(
  metadata: Record<string, unknown>,
  identity: ClaudeCodeIdentity,
): boolean {
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
    userMetadata.device_id = identity.deviceId;
    changed = true;
  }
  if (
    typeof userMetadata.session_id !== "string" ||
    userMetadata.session_id.trim() === ""
  ) {
    userMetadata.session_id = identity.sessionId;
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
 * Injects the Claude Code SDK client identity into an Anthropic request body so
 * gateways that only accept Claude Code clients let it through. Returns whether
 * the payload was modified.
 */
export function injectClaudeCodeIdentity(
  payload: Record<string, unknown>,
  identity: ClaudeCodeIdentity,
  options: InjectClaudeCodeIdentityOptions,
): boolean {
  const systemChanged = ensureSystemMarker(payload);
  if (!options.includeMetadata) {
    return systemChanged;
  }
  const metadata = isRecord(payload.metadata) ? payload.metadata : {};
  const metadataChanged = ensureUserId(metadata, identity);
  if (!isRecord(payload.metadata)) {
    payload.metadata = metadata;
  }
  return systemChanged || metadataChanged;
}

/**
 * Adds the Claude Code client headers required by upstream gateways: the SDK
 * beta token, the CLI user agent, and the CLI app marker. An existing
 * `claude-cli/...` user agent is preserved so a real client is not downgraded.
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
  const userAgent = headers.get("user-agent");
  if (userAgent === null || !CLAUDE_CLI_USER_AGENT_PATTERN.test(userAgent)) {
    headers.set("user-agent", CLAUDE_CLI_USER_AGENT);
  }
  headers.set("x-app", CLAUDE_CODE_X_APP);
}
