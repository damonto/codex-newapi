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

export interface ServiceModelRouteConfig {
  model: string;
}

export interface ServiceConfig {
  id: string;
  base_url: string;
  keys: ServiceApiKeyConfig[];
  disabled: boolean;
  priority: number;
  models: string[];
  model_routes?: Record<string, ServiceModelRouteConfig>;
  supports_websocket: boolean;
  supports_web_search: boolean;
  retry?: ServiceRetryConfig;
}

export interface ClientApiKeyConfig {
  id: string;
  api_key: string;
  services: string[];
  model_routes?: Record<string, ModelRouteConfig>;
}

export interface ModelRouteConfig {
  model: string;
  services?: string[];
}

export type WebSearchMode = "proxy" | "tavily" | "exa";

export interface WebSearchProviderConfig {
  mode: Exclude<WebSearchMode, "proxy">;
  base_url: string;
  api_key: string;
  max_results: number;
}

export type WebSearchConfig = { mode: "proxy" } | WebSearchProviderConfig;

export interface GatewayConfig {
  services: ServiceConfig[];
  api_keys: ClientApiKeyConfig[];
  model_routes: Record<string, ModelRouteConfig>;
  web_search: WebSearchConfig;
}

export interface ServiceHealthSnapshot {
  failures: number;
  cooling_until: number | null;
}
