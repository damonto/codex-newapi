import { exaProvider } from "./exa.ts";
import { tavilyProvider } from "./tavily.ts";
import type { WebSearchProvider, WebSearchProviderMode } from "./types.ts";

type WebSearchProviderRegistry = {
  readonly [Mode in WebSearchProviderMode]: WebSearchProvider & {
    readonly mode: Mode;
  };
};

const WEB_SEARCH_PROVIDERS = Object.freeze({
  tavily: tavilyProvider,
  exa: exaProvider,
}) satisfies WebSearchProviderRegistry;

export const WEB_SEARCH_PROVIDER_MODES = Object.freeze(
  Object.keys(WEB_SEARCH_PROVIDERS) as WebSearchProviderMode[],
);

export function isWebSearchProviderMode(
  mode: string,
): mode is WebSearchProviderMode {
  return Object.hasOwn(WEB_SEARCH_PROVIDERS, mode);
}

export function webSearchProviderFor(
  mode: WebSearchProviderMode,
): WebSearchProvider {
  return WEB_SEARCH_PROVIDERS[mode];
}

export type {
  NormalizedSearchResult,
  WebSearchProvider,
  WebSearchProviderInput,
  WebSearchProviderMode,
} from "./types.ts";

export { ProviderProtocolError } from "./shared.ts";
