import { jsonResponse } from "./http.ts";
import { configureLogging, errorMessage, logWarn } from "./log.ts";
import type { Env, ServiceHealthSnapshot } from "./types.ts";

export const FAILURE_THRESHOLD = 10;
export const FAILURE_WINDOW_MS = 5 * 60 * 1000;
export const COOLDOWN_MS = 30 * 60 * 1000;

export type HealthScope = "inference" | "catalog";

export interface HealthExecutionContext {
  waitUntil?: (promise: Promise<unknown>) => void;
}

export class ServiceHealth implements DurableObject {
  private failures = 0;
  private failureWindowStartedAt: number | null = null;
  private coolingUntil: number | null = null;

  constructor(
    _state: DurableObjectState,
    env: Env,
    private readonly clock: () => number = () => Date.now(),
  ) {
    if (env?.LOG_LEVEL !== undefined) {
      configureLogging(env.LOG_LEVEL);
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

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const now = this.clock();
    this.snapshot(now);

    if (request.method === "GET" && url.pathname === "/status") {
      return jsonResponse(this.snapshot(now));
    }
    if (request.method === "POST" && url.pathname === "/success") {
      this.resetFailures();
      this.coolingUntil = null;
      return jsonResponse(this.snapshot(now));
    }
    if (request.method === "POST" && url.pathname === "/failure") {
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
      return jsonResponse(this.snapshot(now));
    }
    return new Response("Not Found", { status: 404 });
  }
}

function healthObjectName(serviceId: string, scope: HealthScope): string {
  return scope === "inference" ? serviceId : `${serviceId}:catalog`;
}

function healthStub(env: Env, serviceId: string, scope: HealthScope): DurableObjectStub {
  return env.HEALTH.get(env.HEALTH.idFromName(healthObjectName(serviceId, scope)));
}

async function readSnapshot(response: Response): Promise<ServiceHealthSnapshot> {
  if (!response.ok) {
    throw new Error(`health Durable Object returned ${response.status}`);
  }
  return (await response.json()) as ServiceHealthSnapshot;
}

export async function serviceIsAvailable(
  env: Env,
  serviceId: string,
  requestId?: string,
  scope: HealthScope = "inference",
): Promise<boolean> {
  try {
    const response = await healthStub(env, serviceId, scope).fetch("https://health/status");
    const snapshot = await readSnapshot(response);
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
    const response = await healthStub(env, serviceId, scope).fetch(`https://health/${outcome}`, {
      method: "POST",
    });
    const snapshot = await readSnapshot(response);
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
