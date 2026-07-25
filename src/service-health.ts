import { DurableObject } from "cloudflare:workers";

import {
  ServiceHealthState,
  type StoredServiceHealthState,
} from "./health.ts";
import { configureLogging } from "./log.ts";
import type { ServiceHealthSnapshot } from "./types.ts";

const HEALTH_STORAGE_KEY = "health";

function storedStatesEqual(
  left: StoredServiceHealthState | undefined,
  right: StoredServiceHealthState | null,
): boolean {
  if (left === undefined || right === null) {
    return left === undefined && right === null;
  }
  return left.failures === right.failures &&
    left.failure_window_started_at === right.failure_window_started_at &&
    left.cooling_until === right.cooling_until;
}

export class ServiceHealth extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    configureLogging(this.env.LOG_LEVEL);
  }

  private async load(): Promise<{
    health: ServiceHealthState;
    stored: StoredServiceHealthState | undefined;
  }> {
    const stored = await this.ctx.storage.get<StoredServiceHealthState>(HEALTH_STORAGE_KEY);
    return {
      health: new ServiceHealthState(undefined, stored),
      stored,
    };
  }

  private async persist(
    previous: StoredServiceHealthState | undefined,
    next: StoredServiceHealthState | null,
  ): Promise<void> {
    if (storedStatesEqual(previous, next)) {
      return;
    }
    if (next === null) {
      await this.ctx.storage.delete(HEALTH_STORAGE_KEY);
    } else {
      await this.ctx.storage.put(HEALTH_STORAGE_KEY, next);
    }
  }

  async getStatus(): Promise<ServiceHealthSnapshot> {
    const { health, stored } = await this.load();
    const snapshot = health.getStatus();
    await this.persist(stored, health.getStoredState());
    return snapshot;
  }

  async recordSuccess(): Promise<ServiceHealthSnapshot> {
    const { health, stored } = await this.load();
    const snapshot = health.recordSuccess();
    await this.persist(stored, health.getStoredState());
    return snapshot;
  }

  async recordFailure(): Promise<ServiceHealthSnapshot> {
    const { health, stored } = await this.load();
    const snapshot = health.recordFailure();
    await this.persist(stored, health.getStoredState());
    return snapshot;
  }

  async clear(): Promise<ServiceHealthSnapshot> {
    const { health, stored } = await this.load();
    const snapshot = health.clear();
    await this.persist(stored, health.getStoredState());
    return snapshot;
  }
}
