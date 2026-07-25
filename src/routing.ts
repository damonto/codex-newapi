import { serviceIsAvailable } from "./health.ts";
import type {
  ClientApiKeyConfig,
  Env,
  GatewayConfig,
  ServiceConfig,
} from "./types.ts";

export interface ModelRoute {
  requestedModel: string;
  upstreamModel: string;
  services: ServiceConfig[];
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
      allowedServices.has(service.id) &&
      serviceSupportsModel(service, requestedModel, upstreamModel, config.model_aliases),
  );
  return {
    requestedModel,
    upstreamModel,
    services: sortByPriority(services, config),
  };
}

export async function selectAvailableService(
  env: Env,
  route: ModelRoute,
  requestId?: string,
): Promise<ServiceConfig | undefined> {
  for (const service of route.services) {
    if (await serviceIsAvailable(env, service.id, requestId)) {
      return service;
    }
  }
  return undefined;
}

export function allowedServices(
  config: GatewayConfig,
  client: ClientApiKeyConfig,
): ServiceConfig[] {
  const allowed = new Set(client.services);
  return sortByPriority(
    config.services.filter((service) => allowed.has(service.id)),
    config,
  );
}
