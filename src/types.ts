export interface ServiceRetryConfig {
  status_codes: number[];
  delays_ms: number[];
}

export interface ServiceApiKeyConfig {
  id: string;
  api_key: string;
  disabled: boolean;
  priority: number;
}

export interface ServiceConfig {
  id: string;
  base_url: string;
  keys: ServiceApiKeyConfig[];
  disabled: boolean;
  priority: number;
  models: string[];
  retry?: ServiceRetryConfig;
}

export interface ClientApiKeyConfig {
  api_key: string;
  services: string[];
}

export interface ModelRouteConfig {
  model: string;
  services?: string[];
}

export interface GatewayConfig {
  services: ServiceConfig[];
  api_keys: ClientApiKeyConfig[];
  model_routes: Record<string, ModelRouteConfig>;
}

export interface ServiceHealthSnapshot {
  failures: number;
  cooling_until: number | null;
}
