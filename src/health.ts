import {
  mapWithConcurrency,
  SERVICE_FAN_OUT_CONCURRENCY,
} from "./concurrency.ts";
import { errorMessage, logWarn } from "./log.ts";
import type { ServiceConfig, ServiceHealthSnapshot } from "./types.ts";

export const FAILURE_THRESHOLD = 10;
export const FAILURE_WINDOW_MS = 5 * 60 * 1000;
export const COOLDOWN_MS = 30 * 60 * 1000;

export function isHealthFailureStatus(status: number): boolean {
  return status === 400 || status === 503;
}

export function isKeyHealthFailureStatus(status: number): boolean {
  return status === 402 || status === 403;
}

export type HealthScope = "inference" | "catalog";

export interface HealthExecutionContext {
  waitUntil?: (promise: Promise<unknown>) => void;
}

export interface StoredServiceHealthState {
  failures: number;
  failure_window_started_at: number | null;
  cooling_until: number | null;
}

export interface CoolingServiceHealth extends ServiceHealthSnapshot {
  service_id: string;
}

export interface CoolingKeyHealth extends ServiceHealthSnapshot {
  service_id: string;
  key_id: string;
}

export type CoolingHealth = CoolingServiceHealth | CoolingKeyHealth;

export type ServiceAvailabilityReason =
  | "available"
  | "cooling"
  | "health_read_failed";

export interface ServiceAvailability {
  available: boolean;
  reason: ServiceAvailabilityReason;
  failures?: number;
  cooling_until?: number | null;
  error?: string;
}

export class ServiceHealthState {
  private failures = 0;
  private failureWindowStartedAt: number | null = null;
  private coolingUntil: number | null = null;

  constructor(
    private readonly clock: () => number = () => Date.now(),
    stored?: StoredServiceHealthState,
  ) {
    if (stored) {
      this.failures = stored.failures;
      this.failureWindowStartedAt = stored.failure_window_started_at;
      this.coolingUntil = stored.cooling_until;
    }
  }

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

  getStoredState(): StoredServiceHealthState | null {
    if (this.failures === 0 && this.failureWindowStartedAt === null && this.coolingUntil === null) {
      return null;
    }
    return {
      failures: this.failures,
      failure_window_started_at: this.failureWindowStartedAt,
      cooling_until: this.coolingUntil,
    };
  }

  clear(): ServiceHealthSnapshot {
    this.resetFailures();
    this.coolingUntil = null;
    return this.snapshot();
  }

  recordSuccess(): ServiceHealthSnapshot {
    return this.clear();
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

  recordImmediateFailure(): ServiceHealthSnapshot {
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
    }
    this.coolingUntil = now + COOLDOWN_MS;
    return this.snapshot(now);
  }
}

function healthObjectName(serviceId: string, scope: HealthScope): string {
  return scope === "inference" ? serviceId : `${serviceId}:catalog`;
}

function healthStub(env: Env, serviceId: string, scope: HealthScope) {
  return env.HEALTH.getByName(healthObjectName(serviceId, scope));
}

function keyHealthObjectName(
  serviceId: string,
  keyId: string,
  scope: HealthScope,
): string {
  const base = `key:${serviceId}:${keyId}`;
  return scope === "inference" ? base : `${base}:catalog`;
}

function keyHealthStub(
  env: Env,
  serviceId: string,
  keyId: string,
  scope: HealthScope,
) {
  return env.HEALTH.getByName(keyHealthObjectName(serviceId, keyId, scope));
}

export async function getServiceAvailability(
  env: Env,
  serviceId: string,
  scope: HealthScope = "inference",
): Promise<ServiceAvailability> {
  try {
    const snapshot = await healthStub(env, serviceId, scope).getStatus();
    const available = snapshot.cooling_until === null || snapshot.cooling_until <= Date.now();
    return {
      available,
      reason: available ? "available" : "cooling",
      failures: snapshot.failures,
      cooling_until: snapshot.cooling_until,
    };
  } catch (error) {
    return {
      available: true,
      reason: "health_read_failed",
      error: errorMessage(error),
    };
  }
}

export async function serviceIsAvailable(
  env: Env,
  serviceId: string,
  scope: HealthScope = "inference",
): Promise<boolean> {
  return (await getServiceAvailability(env, serviceId, scope)).available;
}

export async function getKeyAvailability(
  env: Env,
  serviceId: string,
  keyId: string,
  scope: HealthScope = "inference",
): Promise<ServiceAvailability> {
  try {
    const snapshot = await keyHealthStub(env, serviceId, keyId, scope).getStatus();
    const available = snapshot.cooling_until === null || snapshot.cooling_until <= Date.now();
    return {
      available,
      reason: available ? "available" : "cooling",
      failures: snapshot.failures,
      cooling_until: snapshot.cooling_until,
    };
  } catch (error) {
    return {
      available: true,
      reason: "health_read_failed",
      error: errorMessage(error),
    };
  }
}

export async function keyIsAvailable(
  env: Env,
  serviceId: string,
  keyId: string,
  scope: HealthScope = "inference",
): Promise<boolean> {
  return (await getKeyAvailability(env, serviceId, keyId, scope)).available;
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

export async function recordKeyFailure(
  env: Env,
  serviceId: string,
  keyId: string,
  requestId?: string,
  scope: HealthScope = "inference",
): Promise<void> {
  try {
    const snapshot = await keyHealthStub(
      env,
      serviceId,
      keyId,
      scope,
    ).recordImmediateFailure();
    logWarn("health.key_cooldown.active", {
      request_id: requestId,
      service_id: serviceId,
      key_id: keyId,
      scope,
      failures: snapshot.failures,
      cooling_until: snapshot.cooling_until,
    });
  } catch (error) {
    logWarn("health.key_update.failed", {
      request_id: requestId,
      service_id: serviceId,
      key_id: keyId,
      scope,
      error: errorMessage(error),
    });
  }
}

export async function clearServiceHealth(
  env: Env,
  serviceId: string,
  scope: HealthScope = "inference",
): Promise<ServiceHealthSnapshot> {
  const snapshot = await healthStub(env, serviceId, scope).clear();
  return snapshot;
}

export async function clearKeyHealth(
  env: Env,
  serviceId: string,
  keyId: string,
  scope: HealthScope = "inference",
): Promise<ServiceHealthSnapshot> {
  return keyHealthStub(env, serviceId, keyId, scope).clear();
}

export async function listCoolingServices(
  env: Env,
  serviceIds: string[],
  scope: HealthScope = "inference",
): Promise<CoolingServiceHealth[]> {
  const statuses = await mapWithConcurrency(
    serviceIds,
    SERVICE_FAN_OUT_CONCURRENCY,
    async (serviceId) => ({
      service_id: serviceId,
      ...await healthStub(env, serviceId, scope).getStatus(),
    }),
  );
  const now = Date.now();
  return statuses.filter(
    (status) => status.cooling_until !== null && status.cooling_until > now,
  );
}

export async function listCoolingHealth(
  env: Env,
  services: ServiceConfig[],
  scope: HealthScope = "inference",
): Promise<CoolingHealth[]> {
  const descriptors = services.flatMap((service) => [
    { kind: "service" as const, service_id: service.id },
    ...service.keys.map((key) => ({
      kind: "key" as const,
      service_id: service.id,
      key_id: key.id,
    })),
  ]);
  const statuses = await mapWithConcurrency(
    descriptors,
    SERVICE_FAN_OUT_CONCURRENCY,
    async (descriptor): Promise<CoolingHealth> => {
      const snapshot = descriptor.kind === "service"
        ? await healthStub(env, descriptor.service_id, scope).getStatus()
        : await keyHealthStub(
          env,
          descriptor.service_id,
          descriptor.key_id,
          scope,
        ).getStatus();
      return descriptor.kind === "service"
        ? { service_id: descriptor.service_id, ...snapshot }
        : {
          service_id: descriptor.service_id,
          key_id: descriptor.key_id,
          ...snapshot,
        };
    },
  );
  const now = Date.now();
  return statuses.filter(
    (status) => status.cooling_until !== null && status.cooling_until > now,
  );
}

export function scheduleHealthUpdate(
  context: HealthExecutionContext | undefined,
  update: Promise<void>,
): Promise<void> {
  if (typeof context?.waitUntil === "function") {
    try {
      context.waitUntil(update);
      return Promise.resolve();
    } catch {
      return update;
    }
  }
  return update;
}
