import assert from "node:assert/strict";
import test from "node:test";

import {
  applyClaudeCodeIdentityHeaders,
  claudeCodeIdentityFor,
  injectClaudeCodeIdentity,
} from "../src/claude-code-identity.ts";

const identity = { deviceId: "device-uuid", sessionId: "session-uuid" };
const withMetadata = { includeMetadata: true };

test("injectClaudeCodeIdentity adds the SDK marker and metadata user id", () => {
  const payload = {
    model: "claude-opus-5",
    system: "You are helpful.",
    metadata: { account_uuid: "account-1" },
  };
  assert.equal(injectClaudeCodeIdentity(payload, identity, withMetadata), true);
  assert.deepEqual(payload.system, [
    {
      type: "text",
      text: "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
    },
    { type: "text", text: "You are helpful." },
  ]);
  const userId = JSON.parse(payload.metadata.user_id);
  assert.equal(userId.device_id, "device-uuid");
  assert.equal(userId.session_id, "session-uuid");
  assert.equal(payload.metadata.account_uuid, "account-1");
});

test("injectClaudeCodeIdentity leaves metadata alone when the endpoint rejects it", () => {
  // count_tokens accepts system but not metadata, and rejects unknown fields.
  const payload = { model: "claude-opus-5", messages: [] };
  assert.equal(
    injectClaudeCodeIdentity(payload, identity, { includeMetadata: false }),
    true,
  );
  assert.equal(Object.hasOwn(payload, "metadata"), false);
  assert.equal(
    payload.system[0].text,
    "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
  );
});

test("claudeCodeIdentityFor is stable per client key and session", async () => {
  const first = await claudeCodeIdentityFor("client-key", "session-a");
  const second = await claudeCodeIdentityFor("client-key", "session-a");
  assert.deepEqual(first, second);

  // Version 8: name-derived, not random.
  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  assert.match(first.deviceId, uuidPattern);
  assert.match(first.sessionId, uuidPattern);

  const otherSession = await claudeCodeIdentityFor("client-key", "session-b");
  assert.equal(otherSession.deviceId, first.deviceId);
  assert.notEqual(otherSession.sessionId, first.sessionId);

  const otherClient = await claudeCodeIdentityFor("other-key", "session-a");
  assert.notEqual(otherClient.deviceId, first.deviceId);

  const noSession = await claudeCodeIdentityFor("client-key");
  assert.equal(noSession.deviceId, first.deviceId);
  assert.deepEqual(noSession, await claudeCodeIdentityFor("client-key"));
});

test("injectClaudeCodeIdentity preserves existing SDK marker and user metadata", () => {
  const marker =
    "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
  const serializedUserId = JSON.stringify({
    device_id: "device-1",
    session_id: "session-1",
    account_uuid: "account-1",
  });
  const payload = {
    model: "claude-opus-5",
    system: [{ type: "text", text: marker }],
    metadata: {
      user_id: serializedUserId,
    },
  };
  assert.equal(
    injectClaudeCodeIdentity(payload, identity, withMetadata),
    false,
  );
  assert.deepEqual(payload, {
    model: "claude-opus-5",
    system: [{ type: "text", text: marker }],
    metadata: {
      user_id: serializedUserId,
    },
  });
});

test("injectClaudeCodeIdentity parses a string metadata user id", () => {
  const payload = {
    model: "claude-opus-5",
    metadata: { user_id: '{"device_id":"device-1"}' },
  };
  assert.equal(injectClaudeCodeIdentity(payload, identity, withMetadata), true);
  assert.deepEqual(JSON.parse(payload.metadata.user_id), {
    device_id: "device-1",
    session_id: JSON.parse(payload.metadata.user_id).session_id,
  });
  assert.equal(
    typeof JSON.parse(payload.metadata.user_id).session_id,
    "string",
  );
});

test("injectClaudeCodeIdentity serializes an object user id to a JSON string", () => {
  const payload = {
    model: "claude-opus-5",
    metadata: { user_id: { device_id: "device-1", account_uuid: "a1" } },
  };
  assert.equal(injectClaudeCodeIdentity(payload, identity, withMetadata), true);
  assert.equal(typeof payload.metadata.user_id, "string");
  const userId = JSON.parse(payload.metadata.user_id);
  assert.equal(userId.device_id, "device-1");
  assert.equal(userId.account_uuid, "a1");
  assert.equal(typeof userId.session_id, "string");
});

test("applyClaudeCodeIdentityHeaders adds the beta header without duplicating it", () => {
  const headers = new Headers({
    "anthropic-beta": "interleaved-thinking-2025-05-14",
  });
  applyClaudeCodeIdentityHeaders(headers);
  assert.equal(
    headers.get("anthropic-beta"),
    "claude-code-20250219,interleaved-thinking-2025-05-14",
  );
  assert.equal(
    headers.get("user-agent"),
    "claude-cli/2.1.246 (external, sdk-cli)",
  );
  assert.equal(headers.get("x-app"), "cli");
});

test("applyClaudeCodeIdentityHeaders leaves an existing beta token in place", () => {
  const headers = new Headers({
    "anthropic-beta": "interleaved-thinking-2025-05-14,claude-code-20250219",
  });
  applyClaudeCodeIdentityHeaders(headers);
  assert.equal(
    headers.get("anthropic-beta"),
    "interleaved-thinking-2025-05-14,claude-code-20250219",
  );
});
