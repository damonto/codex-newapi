import { DurableObject } from "cloudflare:workers";

import {
  affinitySelectionIsHighestPriority,
  chooseAffinityCandidate,
  resolveStoredAffinity,
  SESSION_AFFINITY_TTL_MS,
  type AffinitySelection,
  type AffinityServiceCandidate,
  type SessionAffinityRecord,
  type SessionAffinityRegistration,
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
  SessionAffinityIdentity,
  SessionAffinityRecord,
  SessionAffinityRegistration,
  SessionAffinityResolution,
} from "./affinity.ts";

const AFFINITY_STORAGE_KEY = "affinity";

interface ManagedSessionAffinityRecord extends SessionAffinityRecord {
  binding_id: string;
  created_at: number;
  generation?: number;
  registry_name: string;
  session_digest: string;
  session_id: string;
  index_registered: boolean;
}

interface ClearedSessionAffinityBinding {
  binding_id: string;
  generation?: number;
}

interface AffinityTransactionResult {
  resolution: SessionAffinityResolution | undefined;
  obsolete?: SessionAffinityRecord;
}

function validGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function storedGeneration(record: SessionAffinityRecord | undefined): number | undefined {
  if (record === undefined) {
    return undefined;
  }
  return record.generation === undefined ? 1 : record.generation;
}

function managedRecord(
  record: SessionAffinityRecord,
): record is ManagedSessionAffinityRecord {
  return typeof record.binding_id === "string" &&
    record.binding_id.trim() !== "" &&
    typeof record.created_at === "number" &&
    Number.isSafeInteger(record.created_at) &&
    record.created_at >= 0 &&
    typeof record.registry_name === "string" &&
    typeof record.session_digest === "string" &&
    typeof record.session_id === "string" &&
    record.session_id.length > 0 &&
    typeof record.index_registered === "boolean" &&
    (record.generation === undefined || validGeneration(record.generation));
}

function recordGeneration(record: ManagedSessionAffinityRecord): number {
  return validGeneration(record.generation) ? record.generation : 1;
}

function nextBindingGeneration(
  stored: ManagedSessionAffinityRecord | undefined,
): number {
  const generation = stored === undefined ? 0 : recordGeneration(stored);
  if (generation >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("session affinity generation exhausted");
  }
  return generation + 1;
}

function indexEntry(record: ManagedSessionAffinityRecord) {
  return {
    session_digest: record.session_digest,
    session_id: record.session_id,
    binding_id: record.binding_id,
    created_at: record.created_at,
    generation: recordGeneration(record),
  };
}

export class SessionAffinity extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    configureLogging(this.env.LOG_LEVEL);
  }

  async resolve(
    candidates: AffinityServiceCandidate[],
    preferred?: AffinitySelection,
    registration?: SessionAffinityRegistration,
  ): Promise<SessionAffinityResolution | undefined> {
    const now = Date.now();
    const result: AffinityTransactionResult = await this.ctx.storage.transaction(async (transaction) => {
      const stored = await transaction.get<SessionAffinityRecord>(AFFINITY_STORAGE_KEY);
      const managedStored = stored !== undefined && managedRecord(stored)
        ? stored
        : undefined;
      const storedActive = stored !== undefined &&
        stored.updated_at + SESSION_AFFINITY_TTL_MS > now;
      if (storedActive) {
        const decision = resolveStoredAffinity(stored, candidates, preferred);
        if (!decision.selection) {
          await transaction.delete(AFFINITY_STORAGE_KEY);
          return { resolution: undefined, obsolete: stored };
        }
        const rotateManagedBinding = decision.status === "rebound" &&
          managedStored !== undefined;
        const next: SessionAffinityRecord = {
          ...stored,
          ...decision.selection,
          updated_at: now,
          ...(managedStored
            ? { generation: recordGeneration(managedStored) }
            : {}),
          ...(rotateManagedBinding
            ? {
              binding_id: crypto.randomUUID(),
              created_at: now,
              generation: nextBindingGeneration(managedStored),
              index_registered: false,
            }
            : {}),
        };
        await transaction.put(AFFINITY_STORAGE_KEY, next);
        return {
          resolution: { ...next, status: decision.status },
          ...(rotateManagedBinding ? { obsolete: managedStored } : {}),
        };
      }

      const selected = affinitySelectionIsHighestPriority(preferred, candidates)
        ? preferred
        : chooseAffinityCandidate(candidates);
      if (!selected) {
        await transaction.delete(AFFINITY_STORAGE_KEY);
        return { resolution: undefined, ...(stored ? { obsolete: stored } : {}) };
      }
      const next: SessionAffinityRecord = {
        ...selected,
        updated_at: now,
        ...(registration
          ? {
            binding_id: crypto.randomUUID(),
            created_at: now,
            generation: nextBindingGeneration(managedStored),
            registry_name: registration.registry_name,
            session_digest: registration.session_digest,
            session_id: registration.session_id,
            index_registered: false,
          }
          : {}),
      };
      await transaction.put(AFFINITY_STORAGE_KEY, next);
      return {
        resolution: { ...next, status: "created" as const },
        ...(stored ? { obsolete: stored } : {}),
      };
    });

    try {
      if (result.resolution) {
        await this.ctx.storage.setAlarm(now + SESSION_AFFINITY_TTL_MS);
      } else {
        await this.ctx.storage.deleteAlarm();
      }
    } catch (error) {
      logWarn("affinity.alarm_update.failed", { error: errorMessage(error) });
    }
    this.scheduleIndexSync(result.obsolete, result.resolution);
    return result.resolution;
  }

  private scheduleIndexSync(
    obsolete: SessionAffinityRecord | undefined,
    resolution: SessionAffinityResolution | undefined,
  ): void {
    if (
      !(obsolete && managedRecord(obsolete)) &&
      !(resolution && managedRecord(resolution) && !resolution.index_registered)
    ) {
      return;
    }
    const task = (async () => {
      if (obsolete && managedRecord(obsolete)) {
        await this.unregister(obsolete);
      }
      if (resolution && managedRecord(resolution) && !resolution.index_registered) {
        await this.ensureIndexed(resolution);
      }
    })().catch((error) => {
      logWarn("affinity.index_sync.failed", { error: errorMessage(error) });
    });
    this.ctx.waitUntil(task);
  }

  private async ensureIndexed(record: ManagedSessionAffinityRecord): Promise<void> {
    let candidate: ManagedSessionAffinityRecord = {
      ...record,
      generation: recordGeneration(record),
    };
    try {
      const index = this.env.SESSION_AFFINITY_INDEX.getByName(record.registry_name);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const indexed = await index.register(indexEntry(candidate));
        if (
          indexed.binding_id === candidate.binding_id &&
          indexed.session_id === candidate.session_id &&
          indexed.created_at === candidate.created_at &&
          indexed.generation === recordGeneration(candidate)
        ) {
          const retained = await this.ctx.storage.transaction(async (transaction) => {
            const current = await transaction.get<SessionAffinityRecord>(AFFINITY_STORAGE_KEY);
            if (
              current &&
              current.binding_id === candidate.binding_id &&
              managedRecord(current) &&
              current.registry_name === candidate.registry_name &&
              current.session_digest === candidate.session_digest &&
              current.session_id === candidate.session_id &&
              recordGeneration(current) === recordGeneration(candidate)
            ) {
              await transaction.put(AFFINITY_STORAGE_KEY, {
                ...current,
                generation: recordGeneration(candidate),
                index_registered: true,
              });
              return true;
            }
            return false;
          });
          if (!retained) {
            await index.remove(
              candidate.session_digest,
              candidate.binding_id,
              recordGeneration(candidate),
            );
          }
          return;
        }

        if (indexed.generation < recordGeneration(candidate)) {
          return;
        }
        const replacement = await this.ctx.storage.transaction(async (transaction) => {
          const current = await transaction.get<SessionAffinityRecord>(AFFINITY_STORAGE_KEY);
          if (
            !current ||
            current.binding_id !== candidate.binding_id ||
            !managedRecord(current) ||
            current.registry_name !== candidate.registry_name ||
            current.session_digest !== candidate.session_digest ||
            current.session_id !== candidate.session_id
          ) {
            return undefined;
          }
          const generation = Math.max(
            recordGeneration(current),
            indexed.generation,
          );
          if (generation >= Number.MAX_SAFE_INTEGER) {
            return undefined;
          }
          const next: ManagedSessionAffinityRecord = {
            ...current,
            generation: generation + 1,
            index_registered: false,
          };
          await transaction.put(AFFINITY_STORAGE_KEY, next);
          return next;
        });
        if (!replacement) {
          await index.remove(
            candidate.session_digest,
            candidate.binding_id,
            recordGeneration(candidate),
          );
          return;
        }
        candidate = replacement;
      }
      logWarn("affinity.index_register.conflict", {
        session_digest: candidate.session_digest,
      });
    } catch (error) {
      logWarn("affinity.index_register.failed", {
        session_digest: record.session_digest,
        error: errorMessage(error),
      });
    }
  }

  private async unregister(record: ManagedSessionAffinityRecord): Promise<void> {
    try {
      await this.env.SESSION_AFFINITY_INDEX.getByName(record.registry_name).remove(
        record.session_digest,
        record.binding_id,
        validGeneration(record.generation) ? record.generation : undefined,
      );
    } catch (error) {
      logWarn("affinity.index_remove.failed", {
        session_digest: record.session_digest,
        error: errorMessage(error),
      });
    }
  }

  async getStatus(): Promise<SessionAffinityRecord | null> {
    const stored = await this.ctx.storage.get<SessionAffinityRecord>(AFFINITY_STORAGE_KEY);
    if (!stored || stored.updated_at + SESSION_AFFINITY_TTL_MS <= Date.now()) {
      return null;
    }
    return stored;
  }

  async clear(): Promise<void> {
    const stored = await this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<SessionAffinityRecord>(AFFINITY_STORAGE_KEY);
      await transaction.delete(AFFINITY_STORAGE_KEY);
      await transaction.deleteAlarm();
      return current;
    });
    if (stored && managedRecord(stored)) {
      await this.unregister(stored);
    }
  }

  async clearIfBindingId(
    bindingId: string,
    generation?: number,
  ): Promise<boolean> {
    if (
      typeof bindingId !== "string" ||
      bindingId.trim() === "" ||
      (generation !== undefined && !validGeneration(generation))
    ) {
      return false;
    }
    return this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<SessionAffinityRecord>(AFFINITY_STORAGE_KEY);
      const currentGeneration = storedGeneration(current);
      if (
        !current ||
        current.binding_id !== bindingId ||
        (generation !== undefined &&
          (!validGeneration(currentGeneration) || currentGeneration !== generation))
      ) {
        return false;
      }
      await transaction.delete(AFFINITY_STORAGE_KEY);
      await transaction.deleteAlarm();
      return true;
    });
  }

  async clearManaged(
    registration: SessionAffinityRegistration,
  ): Promise<ClearedSessionAffinityBinding | null> {
    return this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<SessionAffinityRecord>(AFFINITY_STORAGE_KEY);
      if (
        !current ||
        !managedRecord(current) ||
        current.registry_name !== registration.registry_name ||
        current.session_digest !== registration.session_digest ||
        current.session_id !== registration.session_id
      ) {
        return null;
      }
      await transaction.delete(AFFINITY_STORAGE_KEY);
      await transaction.deleteAlarm();
      return {
        binding_id: current.binding_id,
        ...(validGeneration(current.generation)
          ? { generation: current.generation }
          : {}),
      };
    });
  }

  async alarm(): Promise<void> {
    const expired = await this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<SessionAffinityRecord>(AFFINITY_STORAGE_KEY);
      if (!current) {
        await transaction.deleteAlarm();
        return undefined;
      }
      const expiresAt = current.updated_at + SESSION_AFFINITY_TTL_MS;
      if (expiresAt <= Date.now()) {
        await transaction.delete(AFFINITY_STORAGE_KEY);
        await transaction.deleteAlarm();
        return current;
      }
      await transaction.setAlarm(expiresAt);
      return undefined;
    });
    if (expired && managedRecord(expired)) {
      await this.unregister(expired);
    }
  }
}
