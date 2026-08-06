import {
  getServiceAvailability,
  type ServiceAvailability,
} from "./health.ts";
import type {
  ClientApiKeyConfig,
  GatewayConfig,
  ModelRouteConfig,
  ServiceApiKeyConfig,
  ServiceConfig,
} from "./types.ts";

export interface ModelRoute {
  requestedModel: string;
  upstreamModel: string;
  routeApplied: boolean;
  targets: ServiceTarget[];
}

export interface ServiceTarget {
  service: ServiceConfig;
  key: ServiceApiKeyConfig;
}

export interface ServiceSelectionCheck extends ServiceAvailability {
  service_id: string;
}

export interface ServiceSelection {
  target?: ServiceTarget;
  checks: ServiceSelectionCheck[];
}

export function selectServiceApiKey(
  service: ServiceConfig,
): ServiceApiKeyConfig | undefined {
  let selected: ServiceApiKeyConfig | undefined;
  for (const key of service.keys) {
    if (
      !key.disabled &&
      (selected === undefined || key.priority > selected.priority)
    ) {
      selected = key;
    }
  }
  return selected;
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

function targetForService(service: ServiceConfig): ServiceTarget | undefined {
  const key = selectServiceApiKey(service);
  return key ? { service, key } : undefined;
}

function sortTargetsByPriority(
  targets: ServiceTarget[],
  config: GatewayConfig,
): ServiceTarget[] {
  const order = new Map(config.services.map((service, index) => [service.id, index]));
  return [...targets].sort(
    (left, right) =>
      right.service.priority - left.service.priority ||
      (order.get(left.service.id) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(right.service.id) ?? Number.MAX_SAFE_INTEGER),
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
  const targets = config.services.flatMap((service) => {
    if (
      service.disabled ||
      !allowedServices.has(service.id) ||
      !routeAllowsService(configuredRoute, service.id) ||
      !serviceSupportsModel(service, upstreamModel)
    ) {
      return [];
    }
    const target = targetForService(service);
    return target ? [target] : [];
  });
  return {
    requestedModel,
    upstreamModel,
    routeApplied,
    targets: sortTargetsByPriority(targets, config),
  };
}

export async function selectAvailableServiceWithDetails(
  env: Env,
  route: ModelRoute,
): Promise<ServiceSelection> {
  const checks: ServiceSelectionCheck[] = [];
  for (const target of route.targets) {
    const availability = await getServiceAvailability(env, target.service.id);
    checks.push({ service_id: target.service.id, ...availability });
    if (availability.available) {
      return { target, checks };
    }
  }
  return { checks };
}

export async function selectAvailableService(
  env: Env,
  route: ModelRoute,
  _requestId?: string,
): Promise<ServiceConfig | undefined> {
  return (await selectAvailableServiceWithDetails(env, route)).target?.service;
}

export function allowedServiceTargets(
  config: GatewayConfig,
  client: ClientApiKeyConfig,
): ServiceTarget[] {
  const allowed = new Set(client.services);
  const targets = config.services.flatMap((service) => {
    if (service.disabled || !allowed.has(service.id)) {
      return [];
    }
    const target = targetForService(service);
    return target ? [target] : [];
  });
  return sortTargetsByPriority(targets, config);
}
