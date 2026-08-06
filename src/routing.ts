import {
  mapWithConcurrency,
  SERVICE_FAN_OUT_CONCURRENCY,
} from "./concurrency.ts";
import {
  getKeyAvailability,
  getServiceAvailability,
  type HealthScope,
  type ServiceAvailability,
} from "./health.ts";
import { errorMessage } from "./log.ts";
import {
  affinityObjectName,
  chooseAffinityCandidate,
  type AffinityRandomSource,
  type AffinityServiceCandidate,
} from "./affinity.ts";
import { randomEntry, secureRandomUnit } from "./random.ts";
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
  targets: RoutedService[];
}

export interface RoutedService {
  service: ServiceConfig;
  keys: ServiceApiKeyConfig[];
}

export interface ServiceTarget {
  service: ServiceConfig;
  key: ServiceApiKeyConfig;
}

export interface ServiceSelectionCheck extends ServiceAvailability {
  service_id: string;
}

export interface KeySelectionCheck extends ServiceAvailability {
  service_id: string;
  key_id: string;
}

export interface SelectionAffinity {
  status: "hit" | "created" | "rebound" | "failed";
  error?: string;
}

export interface ServiceSelection {
  target?: ServiceTarget;
  checks: ServiceSelectionCheck[];
  keyChecks: KeySelectionCheck[];
  affinity?: SelectionAffinity;
}

export interface ServiceSelectionOptions {
  scope?: HealthScope;
  random?: AffinityRandomSource;
  session?: {
    clientApiKey: string;
    sessionId: string;
  };
}

export type RequiredServiceCapability =
  | "supports_websocket"
  | "supports_web_search";

export interface ResolveModelRouteOptions {
  requiredCapability?: RequiredServiceCapability;
}

export interface CatalogSelection {
  targets: ServiceTarget[];
  checks: ServiceSelectionCheck[];
  keyChecks: KeySelectionCheck[];
}

interface RouteAvailability {
  candidates: RoutedService[];
  checks: ServiceSelectionCheck[];
  keyChecks: KeySelectionCheck[];
}

export function selectServiceApiKey(
  service: ServiceConfig,
  random: AffinityRandomSource = secureRandomUnit,
): ServiceApiKeyConfig | undefined {
  const enabled = service.keys.filter((key) => !key.disabled);
  if (enabled.length === 0) {
    return undefined;
  }
  const priority = Math.max(...enabled.map((key) => key.priority));
  return randomEntry(enabled.filter((key) => key.priority === priority), random);
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

function routedService(service: ServiceConfig): RoutedService | undefined {
  const keys = service.keys.filter((key) => !key.disabled);
  return keys.length > 0 ? { service, keys } : undefined;
}

function sortRoutedServices(
  targets: RoutedService[],
  config: GatewayConfig,
): RoutedService[] {
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
  options: ResolveModelRouteOptions = {},
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
      !serviceSupportsModel(service, upstreamModel) ||
      (options.requiredCapability !== undefined &&
        !service[options.requiredCapability])
    ) {
      return [];
    }
    const target = routedService(service);
    return target ? [target] : [];
  });
  return {
    requestedModel,
    upstreamModel,
    routeApplied,
    targets: sortRoutedServices(targets, config),
  };
}

export function allowedServiceCandidates(
  config: GatewayConfig,
  client: ClientApiKeyConfig,
): RoutedService[] {
  const allowed = new Set(client.services);
  const targets = config.services.flatMap((service) => {
    if (service.disabled || !allowed.has(service.id)) {
      return [];
    }
    const target = routedService(service);
    return target ? [target] : [];
  });
  return sortRoutedServices(targets, config);
}

async function evaluateAvailability(
  env: Env,
  routedServices: RoutedService[],
  scope: HealthScope,
): Promise<RouteAvailability> {
  const checks = await mapWithConcurrency(
    routedServices,
    SERVICE_FAN_OUT_CONCURRENCY,
    async ({ service }): Promise<ServiceSelectionCheck> => ({
      service_id: service.id,
      ...await getServiceAvailability(env, service.id, scope),
    }),
  );
  const availableServiceIds = new Set(
    checks.filter((check) => check.available).map((check) => check.service_id),
  );
  const keyDescriptors = routedServices.flatMap(({ service, keys }) =>
    availableServiceIds.has(service.id)
      ? keys.map((key) => ({ service, key }))
      : []
  );
  const keyChecks = await mapWithConcurrency(
    keyDescriptors,
    SERVICE_FAN_OUT_CONCURRENCY,
    async ({ service, key }): Promise<KeySelectionCheck> => ({
      service_id: service.id,
      key_id: key.id,
      ...await getKeyAvailability(env, service.id, key.id, scope),
    }),
  );
  const availableKeyIds = new Set(
    keyChecks
      .filter((check) => check.available)
      .map((check) => `${check.service_id}\u0000${check.key_id}`),
  );
  const candidates = routedServices.flatMap(({ service, keys }) => {
    if (!availableServiceIds.has(service.id)) {
      return [];
    }
    const availableKeys = keys.filter((key) =>
      availableKeyIds.has(`${service.id}\u0000${key.id}`)
    );
    return availableKeys.length > 0 ? [{ service, keys: availableKeys }] : [];
  });
  return { candidates, checks, keyChecks };
}

function affinityCandidates(
  candidates: RoutedService[],
): AffinityServiceCandidate[] {
  return candidates.map(({ service, keys }) => ({
    service_id: service.id,
    priority: service.priority,
    keys: keys.map((key) => ({
      key_id: key.id,
      priority: key.priority,
    })),
  }));
}

function targetByIds(
  candidates: RoutedService[],
  serviceId: string,
  keyId: string,
): ServiceTarget | undefined {
  const candidate = candidates.find(({ service }) => service.id === serviceId);
  const key = candidate?.keys.find((entry) => entry.id === keyId);
  return candidate && key ? { service: candidate.service, key } : undefined;
}

function selectRandomTarget(
  candidates: RoutedService[],
  random: AffinityRandomSource,
): ServiceTarget | undefined {
  const selected = chooseAffinityCandidate(affinityCandidates(candidates), random);
  return selected
    ? targetByIds(candidates, selected.service_id, selected.key_id)
    : undefined;
}

export async function selectAvailableServiceWithDetails(
  env: Env,
  route: ModelRoute,
  options: ServiceSelectionOptions = {},
): Promise<ServiceSelection> {
  const availability = await evaluateAvailability(
    env,
    route.targets,
    options.scope ?? "inference",
  );
  if (availability.candidates.length === 0) {
    return {
      checks: availability.checks,
      keyChecks: availability.keyChecks,
    };
  }

  if (options.session) {
    const candidates = affinityCandidates(availability.candidates);
    const preferred = chooseAffinityCandidate(
      candidates,
      options.random ?? secureRandomUnit,
    );
    try {
      const name = await affinityObjectName(
        options.session.clientApiKey,
        options.session.sessionId,
      );
      const resolution = await env.SESSION_AFFINITY.getByName(name).resolve(
        candidates,
        preferred,
      );
      if (!resolution) {
        throw new Error("session affinity returned no candidate");
      }
      const target = targetByIds(
        availability.candidates,
        resolution.service_id,
        resolution.key_id,
      );
      if (!target) {
        throw new Error("session affinity returned an unavailable candidate");
      }
      return {
        target,
        checks: availability.checks,
        keyChecks: availability.keyChecks,
        affinity: { status: resolution.status },
      };
    } catch (error) {
      return {
        target: preferred
          ? targetByIds(
            availability.candidates,
            preferred.service_id,
            preferred.key_id,
          )
          : undefined,
        checks: availability.checks,
        keyChecks: availability.keyChecks,
        affinity: { status: "failed", error: errorMessage(error) },
      };
    }
  }

  return {
    target: selectRandomTarget(
      availability.candidates,
      options.random ?? secureRandomUnit,
    ),
    checks: availability.checks,
    keyChecks: availability.keyChecks,
  };
}

export async function selectAvailableService(
  env: Env,
  route: ModelRoute,
  _requestId?: string,
): Promise<ServiceConfig | undefined> {
  return (await selectAvailableServiceWithDetails(env, route)).target?.service;
}

export async function selectAvailableCatalogTargetsWithDetails(
  env: Env,
  routedServices: RoutedService[],
  random: AffinityRandomSource = secureRandomUnit,
): Promise<CatalogSelection> {
  const availability = await evaluateAvailability(env, routedServices, "catalog");
  const targets = availability.candidates.flatMap(({ service, keys }) => {
    const key = selectServiceApiKey({ ...service, keys }, random);
    return key ? [{ service, key }] : [];
  });
  return {
    targets,
    checks: availability.checks,
    keyChecks: availability.keyChecks,
  };
}

export async function targetIsAvailableForRoute(
  env: Env,
  route: ModelRoute,
  target: ServiceTarget,
  scope: HealthScope = "inference",
): Promise<boolean> {
  const routed = route.targets.find(({ service }) => service.id === target.service.id);
  if (!routed?.keys.some((key) => key.id === target.key.id)) {
    return false;
  }
  const [serviceAvailability, keyAvailability] = await Promise.all([
    getServiceAvailability(env, target.service.id, scope),
    getKeyAvailability(env, target.service.id, target.key.id, scope),
  ]);
  return serviceAvailability.available && keyAvailability.available;
}
