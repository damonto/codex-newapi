export interface ServiceConfig {
  id: string;
  base_url: string;
  api_key: string;
  disabled: boolean;
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

export interface ServiceHealthSnapshot {
  failures: number;
  cooling_until: number | null;
}
