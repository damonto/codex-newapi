import { DurableObject } from "cloudflare:workers";

import { SESSION_AFFINITY_INDEX_MAX_PAGE_SIZE } from "./affinity.ts";
import { configureLogging } from "./log.ts";

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

export interface SessionAffinityIndexEntry {
  session_digest: string;
  session_id: string;
  binding_id: string;
  created_at: number;
  generation: number;
}

export interface SessionAffinityIndexPage {
  data: SessionAffinityIndexEntry[];
  next_cursor: string | null;
}

type SessionAffinityIndexRow = SessionAffinityIndexEntry &
  Record<string, SqlStorageValue>;

function validateEntry(entry: SessionAffinityIndexEntry): void {
  if (
    typeof entry !== "object" ||
    entry === null ||
    typeof entry.session_digest !== "string" ||
    !DIGEST_PATTERN.test(entry.session_digest) ||
    typeof entry.session_id !== "string" ||
    entry.session_id.trim() === "" ||
    typeof entry.binding_id !== "string" ||
    entry.binding_id.trim() === "" ||
    !Number.isSafeInteger(entry.created_at) ||
    entry.created_at < 0 ||
    !Number.isSafeInteger(entry.generation) ||
    entry.generation < 1
  ) {
    throw new TypeError("invalid session affinity index entry");
  }
}

export class SessionAffinityIndex extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    configureLogging(this.env.LOG_LEVEL);
    void this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          session_digest TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          binding_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          generation INTEGER NOT NULL DEFAULT 1
        )
      `);
      const columns = this.ctx.storage.sql.exec<{ name: string }>(
        "PRAGMA table_info(sessions)",
      ).toArray();
      if (!columns.some((column) => column.name === "generation")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE sessions ADD COLUMN generation INTEGER NOT NULL DEFAULT 1",
        );
      }
    });
  }

  register(entry: SessionAffinityIndexEntry): SessionAffinityIndexEntry {
    validateEntry(entry);
    this.ctx.storage.sql.exec(
      `INSERT INTO sessions (session_digest, session_id, binding_id, created_at, generation)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_digest) DO UPDATE SET
         session_id = excluded.session_id,
         binding_id = excluded.binding_id,
         created_at = excluded.created_at,
         generation = excluded.generation
       WHERE excluded.generation > sessions.generation
          OR (
            excluded.generation = sessions.generation AND
            excluded.binding_id = sessions.binding_id
          )`,
      entry.session_digest,
      entry.session_id,
      entry.binding_id,
      entry.created_at,
      entry.generation,
    );
    return this.get(entry.session_digest) ?? entry;
  }

  get(sessionDigest: string): SessionAffinityIndexEntry | null {
    if (typeof sessionDigest !== "string" || !DIGEST_PATTERN.test(sessionDigest)) {
      return null;
    }
    return this.ctx.storage.sql.exec<SessionAffinityIndexRow>(
      `SELECT session_digest, session_id, binding_id, created_at, generation
       FROM sessions
       WHERE session_digest = ?`,
      sessionDigest,
    ).toArray()[0] ?? null;
  }

  listPage(cursor: string | null, limit: number): SessionAffinityIndexPage {
    if (
      (cursor !== null &&
        (typeof cursor !== "string" || !DIGEST_PATTERN.test(cursor))) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > SESSION_AFFINITY_INDEX_MAX_PAGE_SIZE
    ) {
      throw new TypeError("invalid session affinity page request");
    }
    const rows = cursor === null
      ? this.ctx.storage.sql.exec<SessionAffinityIndexRow>(
        `SELECT session_digest, session_id, binding_id, created_at, generation
         FROM sessions
         ORDER BY session_digest
         LIMIT ?`,
        limit + 1,
      ).toArray()
      : this.ctx.storage.sql.exec<SessionAffinityIndexRow>(
        `SELECT session_digest, session_id, binding_id, created_at, generation
         FROM sessions
         WHERE session_digest > ?
         ORDER BY session_digest
         LIMIT ?`,
        cursor,
        limit + 1,
      ).toArray();
    const data = rows.slice(0, limit);
    return {
      data,
      next_cursor: rows.length > limit
        ? data[data.length - 1]?.session_digest ?? null
        : null,
    };
  }

  remove(
    sessionDigest: string,
    bindingId: string,
    generation?: number,
  ): boolean {
    if (
      typeof sessionDigest !== "string" ||
      !DIGEST_PATTERN.test(sessionDigest) ||
      typeof bindingId !== "string" ||
      bindingId.trim() === "" ||
      (generation !== undefined &&
        (!Number.isSafeInteger(generation) || generation < 1))
    ) {
      return false;
    }
    const result = generation === undefined
      ? this.ctx.storage.sql.exec(
        "DELETE FROM sessions WHERE session_digest = ? AND binding_id = ?",
        sessionDigest,
        bindingId,
      )
      : this.ctx.storage.sql.exec(
        "DELETE FROM sessions WHERE session_digest = ? AND binding_id = ? AND generation = ?",
        sessionDigest,
        bindingId,
        generation,
      );
    return result.rowsWritten > 0;
  }
}
