import { DurableObject } from "cloudflare:workers";

import { ServiceHealthState } from "./health.ts";
import { configureLogging } from "./log.ts";
import type { ServiceHealthSnapshot } from "./types.ts";

export class ServiceHealth extends DurableObject<Env> {
  private readonly health = new ServiceHealthState();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    configureLogging(this.env.LOG_LEVEL);
  }

  getStatus(): ServiceHealthSnapshot {
    return this.health.getStatus();
  }

  recordSuccess(): ServiceHealthSnapshot {
    return this.health.recordSuccess();
  }

  recordFailure(): ServiceHealthSnapshot {
    return this.health.recordFailure();
  }
}
