import assert from "node:assert/strict";
import test from "node:test";

import {
  applyClaudeCodeIdentityHeaders,
  injectClaudeCodeIdentity,
} from "../src/claude-code-identity.ts";

test("injectClaudeCodeIdentity adds the SDK marker and metadata user id", () => {
  const payload = {
    model: "claude-opus-5",
    system: "You are helpful.",
    metadata: { account_uuid: "account-1" },
  };
  assert.equal(injectClaudeCodeIdentity(payload), true);
  assert.deepEqual(payload.system, [
    {
      type: "text",
      text: "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
    },
    { type: "text", text: "You are helpful." },
  ]);
  const userId = JSON.parse(payload.metadata.user_id);
  assert.equal(typeof userId.device_id, "string");
  assert.equal(typeof userId.session_id, "string");
  assert.equal(userId.device_id.length > 0, true);
  assert.equal(userId.session_id.length > 0, true);
  assert.equal(payload.metadata.account_uuid, "account-1");
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
  assert.equal(injectClaudeCodeIdentity(payload), false);
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
  assert.equal(injectClaudeCodeIdentity(payload), true);
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
  assert.equal(injectClaudeCodeIdentity(payload), true);
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
