import type { NormalizedSearchResult } from "./search-providers/index.ts";
import type { SearchQuery } from "./search-request.ts";

export const MAX_SEARCH_OUTPUT_CHARS = 32 * 1024;

export function codexResults(
  results: NormalizedSearchResult[],
): Record<string, unknown>[] {
  return results.map((result, index) => ({
    type: "text_result",
    ref_id: `turn0search${index}`,
    url: result.url,
    title: result.title,
    snippet: result.snippet,
  }));
}

export function codexOutput(
  queries: SearchQuery[],
  results: NormalizedSearchResult[],
): string {
  const lines = [
    `Search results for ${queries.map((query) => JSON.stringify(query.q)).join(", ")}:`,
  ];
  for (const [index, result] of results.entries()) {
    lines.push(`${index + 1}. ${result.title}`, `URL: ${result.url}`);
    if (result.snippet) {
      lines.push(`Snippet: ${result.snippet}`);
    }
  }
  const output = lines.join("\n");
  return output.length > MAX_SEARCH_OUTPUT_CHARS
    ? `${output.slice(0, MAX_SEARCH_OUTPUT_CHARS - 3)}...`
    : output;
}
