import type {
  WebSearchMode,
  WebSearchProviderConfig,
} from "../types.ts";

export type WebSearchProviderMode = Exclude<WebSearchMode, "proxy">;

export interface WebSearchProviderInput {
  query: string;
  recency?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
}

export interface NormalizedSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchProvider {
  readonly mode: WebSearchProviderMode;
  readonly defaultBaseUrl: string;
  readonly maxResults: {
    readonly default: number;
    readonly min: number;
    readonly max: number;
  };
  readonly maxDomains: {
    readonly include: number;
    readonly exclude: number;
  };
  buildRequest(
    config: WebSearchProviderConfig,
    input: WebSearchProviderInput,
  ): Request;
  parseResponse(body: unknown): NormalizedSearchResult[];
}
