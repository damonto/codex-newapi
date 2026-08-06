import { DurableObject } from "cloudflare:workers";

import {
  chooseAffinityCandidate,
  SESSION_AFFINITY_TTL_MS,
  type AffinitySelection,
  type AffinityServiceCandidate,
  type SessionAffinityRecord,
  type SessionAffinityResolution,
} from "./affinity.ts";
import { configureLogging, errorMessage, logWarn } from "./log.ts";

export {
  affinityObjectName,
  chooseAffinityCandidate,
  SESSION_AFFINITY_TTL_MS,
} from "./affinity.ts";
export type {
  AffinityKeyCandidate,
  AffinityRandomSource,
  AffinitySelection,
  AffinityServiceCandidate,
  SessionAffinityRecord,
  SessionAffinityResolution,
} from "./affinity.ts";

const AFFINITY_STORAGE_KEY = "affinity";

function recordIsCandidate(
  record: SessionAffinityRecord,
  candidates: AffinityServiceCandidate[],
): boolean {
  return candidates.some((service) =>
    service.service_id === record.service_id &&
    service.keys.some((key) => key.key_id === record.key_id)
  );
}

export class SessionAffinity extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    configureLogging(this.env.LOG_LEVEL);
  }

  async resolve(
    candidates: AffinityServiceCandidate[],
    preferred?: AffinitySelection,
  ): Promise<SessionAffinityResolution | undefined> {
    const now = Date.now();
    const resolution = await this.ctx.storage.transaction(async (transaction) => {
      const stored = await transaction.get<SessionAffinityRecord>(AFFINITY_STORAGE_KEY);
      const storedActive = stored !== undefined &&
        stored.updated_at + SESSION_AFFINITY_TTL_MS > now;
      if (storedActive && recordIsCandidate(stored, candidates)) {
        const next: SessionAffinityRecord = { ...stored, updated_at: now };
        await transaction.put(AFFINITY_STORAGE_KEY, next);
        return { ...next, status: "hit" as const };
      }

      const selected = preferred && recordIsCandidate(
          { ...preferred, updated_at: now },
          candidates,
        )
        ? preferred
        : chooseAffinityCandidate(candidates);
      if (!selected) {
        await transaction.delete(AFFINITY_STORAGE_KEY);
        return undefined;
      }
      const next: SessionAffinityRecord = { ...selected, updated_at: now };
      await transaction.put(AFFINITY_STORAGE_KEY, next);
      return {
        ...next,
        status: storedActive ? "rebound" as const : "created" as const,
      };
    });

    try {
      if (resolution) {
        await this.ctx.storage.setAlarm(now + SESSION_AFFINITY_TTL_MS);
      } else {
        await this.ctx.storage.deleteAlarm();
      }
    } catch (error) {
      logWarn("affinity.alarm_update.failed", { error: errorMessage(error) });
    }
    return resolution;
  }

  async getStatus(): Promise<SessionAffinityRecord | null> {
    const stored = await this.ctx.storage.get<SessionAffinityRecord>(AFFINITY_STORAGE_KEY);
    if (!stored || stored.updated_at + SESSION_AFFINITY_TTL_MS <= Date.now()) {
      return null;
    }
    return stored;
  }

  async clear(): Promise<void> {
    await this.ctx.storage.delete(AFFINITY_STORAGE_KEY);
    await this.ctx.storage.deleteAlarm();
  }

  async alarm(): Promise<void> {
    const stored = await this.ctx.storage.get<SessionAffinityRecord>(AFFINITY_STORAGE_KEY);
    if (!stored) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const expiresAt = stored.updated_at + SESSION_AFFINITY_TTL_MS;
    if (expiresAt <= Date.now()) {
      await this.ctx.storage.delete(AFFINITY_STORAGE_KEY);
      return;
    }
    await this.ctx.storage.setAlarm(expiresAt);
  }
}
