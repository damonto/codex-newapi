import {
  dateBeforeDays,
  nonBlankString,
  normalizeProviderResults,
  providerSearchUrl,
} from "./shared.ts";
import type { WebSearchProvider } from "./types.ts";

function resultSnippet(result: Record<string, unknown>): string {
  const highlights = Array.isArray(result.highlights)
    ? nonBlankString(
      result.highlights.map((value) => nonBlankString(value)).filter(Boolean).join(" [...] "),
    )
    : undefined;
  return highlights ?? nonBlankString(result.summary) ?? nonBlankString(result.text) ?? "";
}

export const exaProvider = {
  mode: "exa",
  defaultBaseUrl: "https://api.exa.ai",
  maxResults: { default: 10, min: 1, max: 100 },
  maxDomains: { include: 1200, exclude: 1200 },

  buildRequest(config, input) {
    return new Request(providerSearchUrl(config.base_url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": config.api_key,
      },
      body: JSON.stringify({
        query: input.query,
        numResults: config.max_results,
        contents: { highlights: true },
        ...(input.includeDomains === undefined
          ? {}
          : { includeDomains: input.includeDomains }),
        ...(input.excludeDomains === undefined
          ? {}
          : { excludeDomains: input.excludeDomains }),
        ...(input.recency === undefined
          ? {}
          : { startPublishedDate: `${dateBeforeDays(input.recency)}T00:00:00.000Z` }),
      }),
    });
  },

  parseResponse(body) {
    return normalizeProviderResults(body, resultSnippet);
  },
} satisfies WebSearchProvider;
