import {
  mapWithConcurrency,
  SERVICE_FAN_OUT_CONCURRENCY,
} from "./concurrency.ts";
import {
  affinityObjectNameFromDigests,
  affinityRegistryName,
  sessionAffinityIdentity,
  SESSION_AFFINITY_INDEX_MAX_PAGE_SIZE,
  SESSION_AFFINITY_TTL_MS,
  type SessionAffinityRecord,
  type SessionAffinityRegistration,
} from "./affinity.ts";
import { jsonResponse, openAiError } from "./http.ts";
import type { RequestLogContext } from "./log.ts";
import type { ClientApiKeyConfig } from "./types.ts";
import type {
  SessionAffinityIndexEntry,
  SessionAffinityIndexPage,
} from "./session-affinity-index.ts";

export const SESSION_LIST_DEFAULT_LIMIT = 100;
export const SESSION_LIST_MAX_LIMIT = SESSION_AFFINITY_INDEX_MAX_PAGE_SIZE;

interface SessionBindingView {
  session_id: string;
  service_id: string;
  key_id: string;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

function sessionJsonResponse(value: unknown): Response {
  return jsonResponse(value, 200, { "cache-control": "no-store" });
}

function storedGeneration(record: SessionAffinityRecord): number | undefined {
  if (record.generation === undefined) {
    return 1;
  }
  return Number.isSafeInteger(record.generation) && record.generation >= 1
    ? record.generation
    : undefined;
}

function encodeCursor(value: string): string {
  return btoa(`v1:${value}`)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeCursor(value: string | null): string | null | undefined {
  if (value === null || value.trim() === "") {
    return value === null ? null : undefined;
  }
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") +
      "=".repeat((4 - value.length % 4) % 4);
    const decoded = atob(padded);
    const digest = decoded.startsWith("v1:") ? decoded.slice(3) : "";
    return /^[a-f0-9]{64}$/.test(digest) ? digest : undefined;
  } catch {
    return undefined;
  }
}

function parseLimit(value: string | null): number | undefined {
  if (value === null) {
    return SESSION_LIST_DEFAULT_LIMIT;
  }
  if (!/^\d+$/.test(value)) {
    return undefined;
  }
  const limit = Number(value);
  return Number.isSafeInteger(limit) &&
    limit >= 1 &&
    limit <= SESSION_LIST_MAX_LIMIT
    ? limit
    : undefined;
}

function invalidListQuery(requestLog: RequestLogContext): Response {
  requestLog.warn({
    outcome: "invalid_session_list_query",
    sessions: { action: "list" },
  });
  return openAiError(
    400,
    `limit must be an integer from 1 to ${SESSION_LIST_MAX_LIMIT} and cursor must be valid`,
    "invalid_request_error",
    "invalid_session_list_query",
  );
}

export function decodeSessionIdPath(value: string): string | undefined {
  try {
    const sessionId = decodeURIComponent(value);
    return sessionId.length === 0 ? undefined : sessionId;
  } catch {
    return undefined;
  }
}

function sessionIndex(
  env: Env,
  registryName: string,
) {
  return env.SESSION_AFFINITY_INDEX.getByName(registryName);
}

function sessionAffinity(
  env: Env,
  registryName: string,
  sessionDigest: string,
) {
  return env.SESSION_AFFINITY.getByName(
    affinityObjectNameFromDigests(registryName, sessionDigest),
  );
}

function sessionView(
  entry: SessionAffinityIndexEntry,
  status: SessionAffinityRecord,
  registryName: string,
): SessionBindingView | undefined {
  const statusGeneration = storedGeneration(status);
  if (
    status.binding_id !== entry.binding_id ||
    statusGeneration !== entry.generation ||
    status.session_id !== entry.session_id ||
    status.registry_name !== registryName ||
    status.session_digest !== entry.session_digest ||
    status.created_at !== entry.created_at ||
    typeof status.created_at !== "number" ||
    !Number.isSafeInteger(status.created_at) ||
    status.created_at < 0 ||
    typeof status.updated_at !== "number" ||
    !Number.isSafeInteger(status.updated_at) ||
    status.updated_at < 0 ||
    typeof status.service_id !== "string" ||
    status.service_id.length === 0 ||
    typeof status.key_id !== "string" ||
    status.key_id.length === 0
  ) {
    return undefined;
  }
  return {
    session_id: entry.session_id,
    service_id: status.service_id,
    key_id: status.key_id,
    created_at: status.created_at,
    updated_at: status.updated_at,
    expires_at: status.updated_at + SESSION_AFFINITY_TTL_MS,
  };
}

export async function handleSessionList(
  env: Env,
  client: ClientApiKeyConfig,
  incomingUrl: URL,
  requestLog: RequestLogContext,
): Promise<Response> {
  const limit = parseLimit(incomingUrl.searchParams.get("limit"));
  const cursor = decodeCursor(incomingUrl.searchParams.get("cursor"));
  if (limit === undefined || cursor === undefined) {
    return invalidListQuery(requestLog);
  }

  const registryName = await affinityRegistryName(client.api_key);
  const index = sessionIndex(env, registryName);
  const page: SessionAffinityIndexPage = await index.listPage(cursor, limit);
  const entries = await mapWithConcurrency(
    page.data,
    SERVICE_FAN_OUT_CONCURRENCY,
    async (entry): Promise<SessionBindingView | undefined> => {
      const status = await sessionAffinity(
        env,
        registryName,
        entry.session_digest,
      ).getStatus();
      const view = status ? sessionView(entry, status, registryName) : undefined;
      if (!view) {
        await index.remove(entry.session_digest, entry.binding_id, entry.generation);
      }
      return view;
    },
  );
  const data = entries.filter((entry): entry is SessionBindingView => entry !== undefined);
  requestLog.set({
    sessions: {
      action: "list",
      count: data.length,
      limit,
      has_more: page.next_cursor !== null,
    },
  });
  return sessionJsonResponse({
    object: "list",
    data,
    next_cursor: page.next_cursor === null ? null : encodeCursor(page.next_cursor),
  });
}

async function clearIndexedEntry(
  env: Env,
  registryName: string,
  entry: SessionAffinityIndexEntry,
): Promise<boolean> {
  const affinity = sessionAffinity(
    env,
    registryName,
    entry.session_digest,
  );
  const cleared = await affinity.clearIfBindingId(
    entry.binding_id,
    entry.generation,
  );
  await sessionIndex(env, registryName).remove(
    entry.session_digest,
    entry.binding_id,
    entry.generation,
  );
  return cleared;
}

async function clearManagedByIdentity(
  env: Env,
  identity: SessionAffinityRegistration,
): Promise<boolean> {
  const affinity = sessionAffinity(
    env,
    identity.registry_name,
    identity.session_digest,
  );
  const cleared = await affinity.clearManaged(identity);
  if (cleared) {
    await sessionIndex(env, identity.registry_name).remove(
      identity.session_digest,
      cleared.binding_id,
      cleared.generation,
    );
    return true;
  }
  return false;
}

export async function handleSessionClearAll(
  env: Env,
  client: ClientApiKeyConfig,
  requestLog: RequestLogContext,
): Promise<Response> {
  const registryName = await affinityRegistryName(client.api_key);
  const index = sessionIndex(env, registryName);
  let cursor: string | null = null;
  let deleted = 0;
  do {
    const page = await index.listPage(cursor, SESSION_LIST_MAX_LIMIT);
    const results = await mapWithConcurrency(
      page.data,
      SERVICE_FAN_OUT_CONCURRENCY,
      (entry) => clearIndexedEntry(env, registryName, entry),
    );
    deleted += results.filter(Boolean).length;
    cursor = page.next_cursor;
  } while (cursor !== null);

  requestLog.set({
    sessions: { action: "clear_all", deleted },
  });
  return sessionJsonResponse({ deleted });
}

export async function handleSessionClearOne(
  env: Env,
  client: ClientApiKeyConfig,
  sessionId: string,
  requestLog: RequestLogContext,
): Promise<Response> {
  const identity = await sessionAffinityIdentity(client.api_key, sessionId);
  const index = sessionIndex(env, identity.registry_name);
  const entry = await index.get(identity.session_digest);
  let deleted = 0;
  if (entry && entry.session_id !== sessionId) {
    await index.remove(identity.session_digest, entry.binding_id, entry.generation);
    deleted = Number(await clearManagedByIdentity(env, identity));
  } else if (entry) {
    deleted = Number(await clearIndexedEntry(env, identity.registry_name, entry));
  } else {
    deleted = Number(await clearManagedByIdentity(env, identity));
  }
  requestLog.set({
    sessions: {
      action: "clear_one",
      session_digest: identity.session_digest,
      deleted,
    },
  });
  return sessionJsonResponse({ session_id: sessionId, deleted });
}
