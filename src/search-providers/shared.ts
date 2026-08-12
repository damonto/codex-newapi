import type { NormalizedSearchResult } from "./types.ts";

const MAX_TITLE_CHARS = 512;
const MAX_URL_CHARS = 4096;
const MAX_SNIPPET_CHARS = 4000;

export class ProviderProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderProtocolError";
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function nonBlankString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export function dateBeforeDays(days: number): string {
  const date = new Date(Date.now() - days * 86_400_000);
  return date.toISOString().slice(0, 10);
}

export function providerSearchUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/search`;
}

export function normalizeProviderResults(
  body: unknown,
  snippetFor: (result: Record<string, unknown>) => string,
): NormalizedSearchResult[] {
  if (!isRecord(body) || !Array.isArray(body.results)) {
    throw new ProviderProtocolError("web search provider response must contain a results array");
  }
  return body.results.flatMap((value) => {
    if (!isRecord(value)) {
      return [];
    }
    const url = nonBlankString(value.url);
    if (!url || url.length > MAX_URL_CHARS) {
      return [];
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return [];
    }
    if ((parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") ||
      parsedUrl.username || parsedUrl.password) {
      return [];
    }
    return [{
      title: (nonBlankString(value.title) ?? url).slice(0, MAX_TITLE_CHARS),
      url,
      snippet: snippetFor(value).slice(0, MAX_SNIPPET_CHARS),
    }];
  });
}
