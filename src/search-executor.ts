import { BodyTooLargeError, discardBody, readBodyWithinLimit } from "./body.ts";
import { errorMessage } from "./log.ts";
import {
  type NormalizedSearchResult,
  ProviderProtocolError,
  type WebSearchProvider,
} from "./search-providers/index.ts";
import type { SearchFilters, SearchQuery } from "./search-request.ts";
import { intersectDomains } from "./search-request.ts";
import type { WebSearchProviderConfig } from "./types.ts";

export const MAX_SEARCH_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_SEARCH_BATCH_RESPONSE_BYTES = 4 * 1024 * 1024;
export const SEARCH_PROVIDER_CONCURRENCY = 2;
export const SEARCH_PROVIDER_TIMEOUT_MS = 15_000;

export class ProviderHttpError extends Error {
  constructor(readonly status: number) {
    super(`web search provider returned HTTP ${status}`);
    this.name = "ProviderHttpError";
  }
}

export class ProviderInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderInputError";
  }
}

export class ProviderNetworkError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderNetworkError";
  }
}

export class ProviderTimeoutError extends ProviderNetworkError {
  constructor(readonly timeoutMs: number, options?: ErrorOptions) {
    super(`web search provider timed out after ${timeoutMs} ms`, options);
    this.name = "ProviderTimeoutError";
  }
}

export class ProviderResponseTooLargeError extends ProviderProtocolError {
  constructor(readonly maxBytes: number) {
    super(`web search provider response exceeds the ${maxBytes}-byte limit`);
    this.name = "ProviderResponseTooLargeError";
  }
}

export class SearchBatchBudgetExceededError extends ProviderProtocolError {
  constructor(readonly maxBytes: number) {
    super(`web search provider batch exceeds the ${maxBytes}-byte response budget`);
    this.name = "SearchBatchBudgetExceededError";
  }
}

class SearchBatchBudget {
  private consumedBytes = 0;

  constructor(readonly maxBytes: number) {}

  consume(byteLength: number): void {
    if (this.consumedBytes + byteLength > this.maxBytes) {
      throw new SearchBatchBudgetExceededError(this.maxBytes);
    }
    this.consumedBytes += byteLength;
  }
}

async function fetchProvider(
  provider: WebSearchProvider,
  providerConfig: WebSearchProviderConfig,
  query: SearchQuery,
  filters: SearchFilters,
  budget: SearchBatchBudget,
  signal: AbortSignal,
): Promise<NormalizedSearchResult[]> {
  const includeDomains = intersectDomains(query.domains, filters.allowedDomains);
  if (includeDomains && includeDomains.length > provider.maxDomains.include) {
    throw new ProviderInputError(
      `${provider.mode} supports at most ${provider.maxDomains.include} included domains`,
    );
  }
  if (filters.blockedDomains && filters.blockedDomains.length > provider.maxDomains.exclude) {
    throw new ProviderInputError(
      `${provider.mode} supports at most ${provider.maxDomains.exclude} excluded domains`,
    );
  }
  const providerRequest = provider.buildRequest(providerConfig, {
    query: query.q,
    ...(query.recency === undefined ? {} : { recency: query.recency }),
    ...(includeDomains === undefined ? {} : { includeDomains }),
    ...(filters.blockedDomains === undefined
      ? {}
      : { excludeDomains: filters.blockedDomains }),
  });
  const timeoutController = new AbortController();
  let timeoutError: ProviderTimeoutError | undefined;
  const timeout = setTimeout(() => {
    timeoutError = new ProviderTimeoutError(SEARCH_PROVIDER_TIMEOUT_MS);
    timeoutController.abort(timeoutError);
  }, SEARCH_PROVIDER_TIMEOUT_MS);
  const requestSignal = AbortSignal.any([signal, timeoutController.signal]);
  try {
    const response = await fetch(providerRequest, {
      signal: requestSignal,
      redirect: "manual",
    });
    if (!response.ok) {
      await discardBody(response.body);
      throw new ProviderHttpError(response.status);
    }
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = await readBodyWithinLimit(
        response.body,
        MAX_SEARCH_PROVIDER_RESPONSE_BYTES,
        response.headers.get("content-length"),
        (byteLength) => budget.consume(byteLength),
      );
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        throw new ProviderResponseTooLargeError(MAX_SEARCH_PROVIDER_RESPONSE_BYTES);
      }
      throw error;
    }
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch (error) {
      throw new ProviderProtocolError(
        `web search provider returned invalid JSON (${response.status})`,
        { cause: error },
      );
    }
    return provider.parseResponse(body);
  } catch (error) {
    if (error instanceof ProviderHttpError || error instanceof ProviderProtocolError) {
      throw error;
    }
    if (timeoutError && !signal.aborted) {
      throw timeoutError;
    }
    throw new ProviderNetworkError(
      `web search provider request failed: ${errorMessage(error)}`,
      { cause: error },
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function executeSearchBatch(
  provider: WebSearchProvider,
  providerConfig: WebSearchProviderConfig,
  queries: SearchQuery[],
  filters: SearchFilters,
  requestSignal: AbortSignal,
): Promise<NormalizedSearchResult[]> {
  const batchController = new AbortController();
  const signal = AbortSignal.any([requestSignal, batchController.signal]);
  const budget = new SearchBatchBudget(MAX_SEARCH_BATCH_RESPONSE_BYTES);
  const responses = new Array<NormalizedSearchResult[]>(queries.length);
  let nextIndex = 0;
  let firstError: unknown;
  const workers = Array.from(
    { length: Math.min(SEARCH_PROVIDER_CONCURRENCY, queries.length) },
    async () => {
      while (!signal.aborted) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= queries.length) {
          return;
        }
        try {
          responses[index] = await fetchProvider(
            provider,
            providerConfig,
            queries[index],
            filters,
            budget,
            signal,
          );
        } catch (error) {
          if (firstError === undefined) {
            firstError = error;
            batchController.abort(error);
          }
          return;
        }
      }
    },
  );
  await Promise.all(workers);
  if (firstError !== undefined) {
    throw firstError;
  }
  if (requestSignal.aborted) {
    throw new ProviderNetworkError("web search request was aborted", {
      cause: requestSignal.reason,
    });
  }
  return responses.flat();
}
