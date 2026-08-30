import {
  chooseAffinityCandidate,
  sessionAffinityIdentity,
  type AffinityRandomSource,
  type AffinityServiceCandidate,
} from "./affinity.ts";
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
import { randomEntry } from "./random.ts";
import type {
  ClientApiKeyConfig,
  GatewayConfig,
  ModelRouteConfig,
  ServiceApiKeyConfig,
  ServiceConfig,
} from "./types.ts";

export interface ModelRoute {
  requestedModel: string;
  targets: ModelRoutedService[];
}

export interface RoutedService {
  service: ServiceConfig;
  keys: ServiceApiKeyConfig[];
}

export interface ModelRoutedService extends RoutedService {
  upstreamModel: string;
  routeApplied: boolean;
}

export interface ServiceTarget {
  service: ServiceConfig;
  key: ServiceApiKeyConfig;
}

export interface ModelServiceTarget extends ServiceTarget {
  upstreamModel: string;
  routeApplied: boolean;
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
  // Always present, possibly undefined: selection computes a target that may
  // not exist. `affinity` is genuinely absent when no session was involved.
  target: ModelServiceTarget | undefined;
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
  "supports_websocket" | "supports_web_search";

export interface ResolveModelRouteOptions {
  requiredCapability?: RequiredServiceCapability;
}

export interface CatalogSelection {
  targets: ServiceTarget[];
  checks: ServiceSelectionCheck[];
  keyChecks: KeySelectionCheck[];
}

interface RouteAvailability<T extends RoutedService> {
  candidates: T[];
  checks: ServiceSelectionCheck[];
  keyChecks: KeySelectionCheck[];
}

export function modelRoutesForService(
  config: GatewayConfig,
  client: ClientApiKeyConfig,
  service: ServiceConfig,
): Record<string, ModelRouteConfig> {
  return {
    ...config.model_routes,
    ...client.model_routes,
    ...service.model_routes,
  };
}

export function modelRoutesByService(
  config: GatewayConfig,
  client: ClientApiKeyConfig,
): Map<string, Record<string, ModelRouteConfig>> {
  const allowedServices = new Set(client.services);
  return new Map(
    config.services
      .filter((service) => allowedServices.has(service.id))
      .map((service) => [
        service.id,
        modelRoutesForService(config, client, service),
      ]),
  );
}

export function selectServiceApiKey(
  service: ServiceConfig,
  random?: AffinityRandomSource,
): ServiceApiKeyConfig | undefined {
  const enabled = service.keys.filter((key) => !key.disabled);
  if (enabled.length === 0) {
    return undefined;
  }
  const priority = Math.max(...enabled.map((key) => key.priority));
  const tied = enabled.filter((key) => key.priority === priority);
  return random === undefined ? tied[0] : randomEntry(tied, random);
}

export function serviceSupportsModel(
  service: ServiceConfig,
  upstreamModel: string,
): boolean {
  return service.models.includes(upstreamModel);
}

function routeAllowsService(
  route: ModelRouteConfig | undefined,
  serviceId: string,
): boolean {
  return route?.services === undefined || route.services.includes(serviceId);
}

function routedService(service: ServiceConfig): RoutedService | undefined {
  const keys = service.keys.filter((key) => !key.disabled);
  return keys.length > 0 ? { service, keys } : undefined;
}

function sortRoutedServices<T extends RoutedService>(
  targets: T[],
  config: GatewayConfig,
): T[] {
  const order = new Map(
    config.services.map((service, index) => [service.id, index]),
  );
  const serviceOrder = (serviceId: string): number => {
    const index = order.get(serviceId);
    if (index === undefined) {
      throw new Error(
        `routed service ${serviceId} is missing from configuration`,
      );
    }
    return index;
  };
  return [...targets].sort(
    (left, right) =>
      right.service.priority - left.service.priority ||
      serviceOrder(left.service.id) - serviceOrder(right.service.id),
  );
}

export function resolveModelRoute(
  config: GatewayConfig,
  client: ClientApiKeyConfig,
  requestedModel: string,
  options: ResolveModelRouteOptions = {},
): ModelRoute {
  const allowedServices = new Set(client.services);
  const targets = config.services.flatMap<ModelRoutedService>((service) => {
    if (
      service.disabled ||
      !allowedServices.has(service.id) ||
      (options.requiredCapability !== undefined &&
        !service[options.requiredCapability])
    ) {
      return [];
    }
    const modelRoutes = modelRoutesForService(config, client, service);
    const serviceRouteApplied = Object.hasOwn(modelRoutes, requestedModel);
    const configuredRoute = serviceRouteApplied
      ? modelRoutes[requestedModel]
      : undefined;
    const upstreamModel = configuredRoute?.model ?? requestedModel;
    if (
      !routeAllowsService(configuredRoute, service.id) ||
      !serviceSupportsModel(service, upstreamModel)
    ) {
      return [];
    }
    const target = routedService(service);
    return target
      ? [{ ...target, upstreamModel, routeApplied: serviceRouteApplied }]
      : [];
  });
  return {
    requestedModel,
    targets: sortRoutedServices(targets, config),
  };
}

export function modelIsAvailableForClient(
  config: GatewayConfig,
  client: ClientApiKeyConfig,
  requestedModel: string,
  options: ResolveModelRouteOptions = {},
): boolean {
  return (
    resolveModelRoute(config, client, requestedModel, options).targets.length >
    0
  );
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

async function evaluateAvailability<T extends RoutedService>(
  env: Env,
  routedServices: T[],
  scope: HealthScope,
): Promise<RouteAvailability<T>> {
  const checks = await mapWithConcurrency(
    routedServices,
    SERVICE_FAN_OUT_CONCURRENCY,
    async ({ service }): Promise<ServiceSelectionCheck> => ({
      service_id: service.id,
      ...(await getServiceAvailability(env, service.id, scope)),
    }),
  );
  const availableServiceIds = new Set(
    checks.filter((check) => check.available).map((check) => check.service_id),
  );
  const keyDescriptors = routedServices.flatMap(({ service, keys }) =>
    availableServiceIds.has(service.id)
      ? keys.map((key) => ({ service, key }))
      : [],
  );
  const keyChecks = await mapWithConcurrency(
    keyDescriptors,
    SERVICE_FAN_OUT_CONCURRENCY,
    async ({ service, key }): Promise<KeySelectionCheck> => ({
      service_id: service.id,
      key_id: key.id,
      ...(await getKeyAvailability(env, service.id, key.id, scope)),
    }),
  );
  const availableKeyIds = new Set(
    keyChecks
      .filter((check) => check.available)
      .map((check) => `${check.service_id}\u0000${check.key_id}`),
  );
  const candidates = routedServices.flatMap<T>((routed) => {
    const { service, keys } = routed;
    if (!availableServiceIds.has(service.id)) {
      return [];
    }
    const availableKeys = keys.filter((key) =>
      availableKeyIds.has(`${service.id}\u0000${key.id}`),
    );
    return availableKeys.length > 0 ? [{ ...routed, keys: availableKeys }] : [];
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
  candidates: ModelRoutedService[],
  serviceId: string,
  keyId: string,
): ModelServiceTarget | undefined {
  const candidate = candidates.find(({ service }) => service.id === serviceId);
  const key = candidate?.keys.find((entry) => entry.id === keyId);
  return candidate && key
    ? {
        service: candidate.service,
        key,
        upstreamModel: candidate.upstreamModel,
        routeApplied: candidate.routeApplied,
      }
    : undefined;
}

function selectRandomTarget(
  candidates: ModelRoutedService[],
  random?: AffinityRandomSource,
): ModelServiceTarget | undefined {
  const selected = chooseAffinityCandidate(
    affinityCandidates(candidates),
    random,
  );
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
      target: undefined,
      checks: availability.checks,
      keyChecks: availability.keyChecks,
    };
  }

  if (options.session) {
    const candidates = affinityCandidates(availability.candidates);
    const preferred = chooseAffinityCandidate(candidates, options.random);
    try {
      const identity = await sessionAffinityIdentity(
        options.session.clientApiKey,
        options.session.sessionId,
      );
      const resolution = await env.SESSION_AFFINITY.getByName(
        identity.object_name,
      ).resolve(candidates, preferred, identity);
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
    target: selectRandomTarget(availability.candidates, options.random),
    checks: availability.checks,
    keyChecks: availability.keyChecks,
  };
}

export async function selectAvailableService(
  env: Env,
  route: ModelRoute,
): Promise<ServiceConfig | undefined> {
  return (await selectAvailableServiceWithDetails(env, route)).target?.service;
}

export async function selectAvailableCatalogTargetsWithDetails(
  env: Env,
  routedServices: RoutedService[],
  random?: AffinityRandomSource,
): Promise<CatalogSelection> {
  const availability = await evaluateAvailability(
    env,
    routedServices,
    "catalog",
  );
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
  target: ModelServiceTarget,
  scope: HealthScope = "inference",
): Promise<boolean> {
  const routed = route.targets.find(
    ({ service }) => service.id === target.service.id,
  );
  if (!routed?.keys.some((key) => key.id === target.key.id)) {
    return false;
  }
  const [serviceAvailability, keyAvailability] = await Promise.all([
    getServiceAvailability(env, target.service.id, scope),
    getKeyAvailability(env, target.service.id, target.key.id, scope),
  ]);
  return serviceAvailability.available && keyAvailability.available;
}
