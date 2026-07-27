import {
  getServiceAvailability,
  type ServiceAvailability,
} from "./health.ts";
import type {
  ClientApiKeyConfig,
  GatewayConfig,
  ServiceConfig,
} from "./types.ts";

export interface ModelRoute {
  requestedModel: string;
  upstreamModel: string;
  services: ServiceConfig[];
}

export interface ServiceSelectionCheck extends ServiceAvailability {
  service_id: string;
}

export interface ServiceSelection {
  service?: ServiceConfig;
  checks: ServiceSelectionCheck[];
}

export function serviceSupportsModel(
  service: ServiceConfig,
  requestedModel: string,
  upstreamModel: string,
  aliases: Record<string, string>,
): boolean {
  return (aliases[requestedModel] ?? requestedModel) === upstreamModel &&
    service.models.includes(upstreamModel);
}

export function serviceSupportsAutoReview(
  service: ServiceConfig,
  upstreamModel: string,
): boolean {
  return service.models.includes(upstreamModel);
}

function sortByPriority(services: ServiceConfig[], config: GatewayConfig): ServiceConfig[] {
  const order = new Map(config.services.map((service, index) => [service.id, index]));
  return [...services].sort(
    (left, right) =>
      right.priority - left.priority ||
      (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(right.id) ?? Number.MAX_SAFE_INTEGER),
  );
}

export function resolveModelRoute(
  config: GatewayConfig,
  client: ClientApiKeyConfig,
  requestedModel: string,
): ModelRoute {
  const allowedServices = new Set(client.services);

  if (requestedModel === "codex-auto-review") {
    const service = config.services.find(
      (entry) =>
        entry.id === config.codex_auto_review.service &&
        !entry.disabled &&
        allowedServices.has(entry.id) &&
        serviceSupportsAutoReview(entry, config.codex_auto_review.model),
    );
    return {
      requestedModel,
      upstreamModel: config.codex_auto_review.model,
      services: service ? [service] : [],
    };
  }

  const upstreamModel = config.model_aliases[requestedModel] ?? requestedModel;
  const services = config.services.filter(
    (service) =>
      !service.disabled &&
      allowedServices.has(service.id) &&
      serviceSupportsModel(service, requestedModel, upstreamModel, config.model_aliases),
  );
  return {
    requestedModel,
    upstreamModel,
    services: sortByPriority(services, config),
  };
}

export async function selectAvailableServiceWithDetails(
  env: Env,
  route: ModelRoute,
): Promise<ServiceSelection> {
  const checks: ServiceSelectionCheck[] = [];
  for (const service of route.services) {
    const availability = await getServiceAvailability(env, service.id);
    checks.push({ service_id: service.id, ...availability });
    if (availability.available) {
      return { service, checks };
    }
  }
  return { checks };
}

export async function selectAvailableService(
  env: Env,
  route: ModelRoute,
  _requestId?: string,
): Promise<ServiceConfig | undefined> {
  return (await selectAvailableServiceWithDetails(env, route)).service;
}

export function allowedServices(
  config: GatewayConfig,
  client: ClientApiKeyConfig,
): ServiceConfig[] {
  const allowed = new Set(client.services);
  return sortByPriority(
    config.services.filter((service) => !service.disabled && allowed.has(service.id)),
    config,
  );
}
