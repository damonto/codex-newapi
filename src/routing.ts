import {
  getServiceAvailability,
  type ServiceAvailability,
} from "./health.ts";
import type {
  ClientApiKeyConfig,
  GatewayConfig,
  ModelRouteConfig,
  ServiceConfig,
} from "./types.ts";

export interface ModelRoute {
  requestedModel: string;
  upstreamModel: string;
  routeApplied: boolean;
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
  upstreamModel: string,
): boolean {
  return service.models.includes(upstreamModel);
}

function routeAllowsService(route: ModelRouteConfig | undefined, serviceId: string): boolean {
  return route?.services === undefined || route.services.includes(serviceId);
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
  const routeApplied = Object.hasOwn(config.model_routes, requestedModel);
  const configuredRoute = routeApplied
    ? config.model_routes[requestedModel]
    : undefined;
  const upstreamModel = configuredRoute?.model ?? requestedModel;
  const services = config.services.filter(
    (service) =>
      !service.disabled &&
      allowedServices.has(service.id) &&
      routeAllowsService(configuredRoute, service.id) &&
      serviceSupportsModel(service, upstreamModel),
  );
  return {
    requestedModel,
    upstreamModel,
    routeApplied,
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
