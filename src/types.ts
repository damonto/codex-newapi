export interface ServiceConfig {
  id: string;
  base_url: string;
  api_key: string;
  priority: number;
  models: string[];
}

export interface ClientApiKeyConfig {
  api_key: string;
  services: string[];
}

export interface CodexAutoReviewConfig {
  service: string;
  model: string;
}

export interface GatewayConfig {
  services: ServiceConfig[];
  api_keys: ClientApiKeyConfig[];
  model_aliases: Record<string, string>;
  codex_auto_review: CodexAutoReviewConfig;
}

export interface Env {
  CODEX_NEWAPI_CONFIG_KV: KVNamespace;
  HEALTH: DurableObjectNamespace;
  CONFIG_KEY?: string;
  CONFIG_CACHE_TTL_SECONDS?: string;
  MODELS_CACHE_TTL_SECONDS?: string;
  LOG_LEVEL?: string;
}

export interface ServiceHealthSnapshot {
  failures: number;
  cooling_until: number | null;
}
