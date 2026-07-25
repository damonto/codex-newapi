import { errorMessage, logWarn } from "./log.ts";
import type { ServiceHealthSnapshot } from "./types.ts";

export const FAILURE_THRESHOLD = 10;
export const FAILURE_WINDOW_MS = 5 * 60 * 1000;
export const COOLDOWN_MS = 30 * 60 * 1000;

export function isHealthFailureStatus(status: number): boolean {
  return status === 400 || status === 503;
}

export type HealthScope = "inference" | "catalog";

export interface HealthExecutionContext {
  waitUntil?: (promise: Promise<unknown>) => void;
}

export class ServiceHealthState {
  private failures = 0;
  private failureWindowStartedAt: number | null = null;
  private coolingUntil: number | null = null;

  constructor(private readonly clock: () => number = () => Date.now()) {}

  private resetFailures(): void {
    this.failures = 0;
    this.failureWindowStartedAt = null;
  }

  private snapshot(now = this.clock()): ServiceHealthSnapshot {
    if (this.coolingUntil !== null && now >= this.coolingUntil) {
      this.resetFailures();
      this.coolingUntil = null;
    }
    if (
      this.coolingUntil === null &&
      this.failureWindowStartedAt !== null &&
      now - this.failureWindowStartedAt >= FAILURE_WINDOW_MS
    ) {
      this.resetFailures();
    }
    return {
      failures: this.failures,
      cooling_until: this.coolingUntil,
    };
  }

  getStatus(): ServiceHealthSnapshot {
    const now = this.clock();
    return this.snapshot(now);
  }

  recordSuccess(): ServiceHealthSnapshot {
    this.resetFailures();
    this.coolingUntil = null;
    return this.snapshot();
  }

  recordFailure(): ServiceHealthSnapshot {
    const now = this.clock();
    this.snapshot(now);
    if (this.coolingUntil === null) {
      if (
        this.failureWindowStartedAt === null ||
        now - this.failureWindowStartedAt >= FAILURE_WINDOW_MS
      ) {
        this.resetFailures();
        this.failureWindowStartedAt = now;
      }
      this.failures += 1;
      if (this.failures >= FAILURE_THRESHOLD) {
        this.coolingUntil = now + COOLDOWN_MS;
      }
    }
    return this.snapshot(now);
  }
}

function healthObjectName(serviceId: string, scope: HealthScope): string {
  return scope === "inference" ? serviceId : `${serviceId}:catalog`;
}

function healthStub(env: Env, serviceId: string, scope: HealthScope) {
  return env.HEALTH.getByName(healthObjectName(serviceId, scope));
}

export async function serviceIsAvailable(
  env: Env,
  serviceId: string,
  requestId?: string,
  scope: HealthScope = "inference",
): Promise<boolean> {
  try {
    const snapshot = await healthStub(env, serviceId, scope).getStatus();
    const available = snapshot.cooling_until === null || snapshot.cooling_until <= Date.now();
    if (!available) {
      logWarn("health.service.cooling", {
        request_id: requestId,
        service_id: serviceId,
        scope,
        failures: snapshot.failures,
        cooling_until: snapshot.cooling_until,
      });
    }
    return available;
  } catch (error) {
    logWarn("health.status.read_failed", {
      request_id: requestId,
      service_id: serviceId,
      scope,
      error: errorMessage(error),
    });
    return true;
  }
}

async function record(
  env: Env,
  serviceId: string,
  outcome: "success" | "failure",
  requestId?: string,
  scope: HealthScope = "inference",
): Promise<void> {
  try {
    const stub = healthStub(env, serviceId, scope);
    const snapshot = outcome === "success"
      ? await stub.recordSuccess()
      : await stub.recordFailure();
    if (outcome === "failure" && snapshot.cooling_until !== null) {
      logWarn("health.cooldown.active", {
        request_id: requestId,
        service_id: serviceId,
        scope,
        failures: snapshot.failures,
        cooling_until: snapshot.cooling_until,
      });
    }
  } catch (error) {
    logWarn("health.update.failed", {
      request_id: requestId,
      service_id: serviceId,
      scope,
      outcome,
      error: errorMessage(error),
    });
  }
}

export function recordServiceSuccess(
  env: Env,
  serviceId: string,
  requestId?: string,
  scope: HealthScope = "inference",
): Promise<void> {
  return record(env, serviceId, "success", requestId, scope);
}

export function recordServiceFailure(
  env: Env,
  serviceId: string,
  requestId?: string,
  scope: HealthScope = "inference",
): Promise<void> {
  return record(env, serviceId, "failure", requestId, scope);
}

export function scheduleHealthUpdate(
  context: HealthExecutionContext | undefined,
  update: Promise<void>,
): Promise<void> {
  if (typeof context?.waitUntil === "function") {
    context.waitUntil(update);
    return Promise.resolve();
  }
  return update;
}
