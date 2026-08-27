import assert from "node:assert/strict";
import test from "node:test";

import { handleConfiguredWebSearch } from "../src/search.ts";
import { webSearchProviderFor } from "../src/search-providers/index.ts";
import {
  MAX_SEARCH_BATCH_RESPONSE_BYTES,
  MAX_SEARCH_PROVIDER_RESPONSE_BYTES,
  SEARCH_PROVIDER_CONCURRENCY,
} from "../src/search-executor.ts";

function fixture(mode) {
  return {
    config: {
      services: [
        {
          id: "inference",
          base_url: "https://inference.example/v1",
          keys: [
            {
              id: "inference-key",
              api_key: "inference-secret",
              disabled: false,
              priority: 100,
            },
          ],
          disabled: false,
          priority: 100,
          models: ["upstream-model"],
          supports_websocket: false,
          supports_web_search: false,
        },
      ],
      api_keys: [
        { id: "client", api_key: "client-key", services: ["inference"] },
      ],
      model_routes: { "client-model": { model: "upstream-model" } },
      web_search: {
        mode,
        base_url: `https://${mode}.example`,
        api_key: `${mode}-secret`,
        max_results: 3,
      },
    },
    client: { id: "client", api_key: "client-key", services: ["inference"] },
  };
}

function request(commands, settings) {
  return new Request("https://gateway.example/v1/alpha/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "thread-1",
      model: "client-model",
      input: [{ role: "user", content: "private conversation" }],
      commands,
      ...(settings === undefined ? {} : { settings }),
    }),
  });
}

test("web search providers are selected from the registry", () => {
  assert.equal(webSearchProviderFor("tavily").mode, "tavily");
  assert.equal(webSearchProviderFor("exa").mode, "exa");
});

test("Tavily adapter maps search queries and emits Codex search output", async () => {
  const { config, client } = fixture("tavily");
  const originalFetch = globalThis.fetch;
  const captured = [];
  globalThis.fetch = async (input, init) => {
    const upstream =
      input instanceof Request ? input : new Request(input, init);
    captured.push({
      url: upstream.url,
      authorization: upstream.headers.get("authorization"),
      body: JSON.parse(await upstream.text()),
    });
    return Response.json({
      results: [
        {
          title: "Tavily result",
          url: "https://result.example/tavily",
          content: "Relevant Tavily content",
          score: 0.9,
        },
      ],
    });
  };
  try {
    const response = await handleConfiguredWebSearch(
      request({
        search_query: [
          { q: "latest docs", recency: 7, domains: ["docs.example"] },
        ],
      }),
      config,
      client,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      encrypted_output: null,
      output: [
        'Search results for "latest docs":',
        "1. Tavily result",
        "URL: https://result.example/tavily",
        "Snippet: Relevant Tavily content",
      ].join("\n"),
      results: [
        {
          type: "text_result",
          ref_id: "turn0search0",
          url: "https://result.example/tavily",
          title: "Tavily result",
          snippet: "Relevant Tavily content",
        },
      ],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, "https://tavily.example/search");
  assert.equal(captured[0].authorization, "Bearer tavily-secret");
  assert.deepEqual(captured[0].body, {
    query: "latest docs",
    include_domains: ["docs.example"],
    max_results: 3,
    include_answer: false,
    include_raw_content: false,
    start_date: new Date(Date.now() - 7 * 86_400_000)
      .toISOString()
      .slice(0, 10),
  });
  assert.equal(
    JSON.stringify(captured[0].body).includes("private conversation"),
    false,
  );
});

test("Exa adapter maps each query without proxy fallback", async () => {
  const { config, client } = fixture("exa");
  const originalFetch = globalThis.fetch;
  const captured = [];
  globalThis.fetch = async (input, init) => {
    const upstream =
      input instanceof Request ? input : new Request(input, init);
    captured.push({
      url: upstream.url,
      apiKey: upstream.headers.get("x-api-key"),
      body: JSON.parse(await upstream.text()),
    });
    return Response.json({
      results: [
        {
          title: "Exa result",
          url: `https://result.example/${captured.length}`,
          highlights: ["First highlight", "Second highlight"],
        },
      ],
    });
  };
  try {
    const response = await handleConfiguredWebSearch(
      request({
        search_query: [{ q: "one" }, { q: "two", domains: ["exa.ai"] }],
      }),
      config,
      client,
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.results.length, 2);
    assert.equal(
      body.results[0].snippet,
      "First highlight [...] Second highlight",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(
    captured.map((entry) => entry.url),
    ["https://exa.example/search", "https://exa.example/search"],
  );
  assert.deepEqual(
    captured.map((entry) => entry.apiKey),
    ["exa-secret", "exa-secret"],
  );
  assert.deepEqual(captured[1].body, {
    query: "two",
    numResults: 3,
    contents: { highlights: true },
    includeDomains: ["exa.ai"],
  });
});

test("adapter enforces global domain filters", async () => {
  const { config, client } = fixture("exa");
  const originalFetch = globalThis.fetch;
  let providerBody;
  globalThis.fetch = async (input, init) => {
    const upstream =
      input instanceof Request ? input : new Request(input, init);
    providerBody = JSON.parse(await upstream.text());
    return Response.json({ results: [] });
  };
  try {
    const response = await handleConfiguredWebSearch(
      request(
        {
          search_query: [
            { q: "docs", domains: ["docs.example", "other.example"] },
          ],
        },
        {
          filters: {
            allowed_domains: ["docs.example"],
            blocked_domains: ["blocked.example"],
          },
        },
      ),
      config,
      client,
    );
    assert.equal(response.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(providerBody, {
    query: "docs",
    numResults: 3,
    contents: { highlights: true },
    includeDomains: ["docs.example"],
    excludeDomains: ["blocked.example"],
  });
});

test("adapters enforce provider-specific domain limits", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({ results: [] });
  };
  try {
    for (const [mode, domainCount] of [
      ["tavily", 301],
      ["exa", 1201],
    ]) {
      const { config, client } = fixture(mode);
      const response = await handleConfiguredWebSearch(
        request(
          { search_query: [{ q: "docs" }] },
          {
            filters: {
              allowed_domains: Array.from(
                { length: domainCount },
                (_, index) => `domain-${index}.example`,
              ),
            },
          },
        ),
        config,
        client,
      );
      assert.equal(response.status, 400);
      assert.equal(
        (await response.json()).error.code,
        "invalid_search_request",
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls, 0);
});

test("adapter rejects a query whose domains do not satisfy the global allowlist", async () => {
  const { config, client } = fixture("tavily");
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({ results: [] });
  };
  try {
    const response = await handleConfiguredWebSearch(
      request(
        { search_query: [{ q: "docs", domains: ["query.example"] }] },
        { filters: { allowed_domains: ["allowed.example"] } },
      ),
      config,
      client,
    );
    assert.equal(response.status, 400);
    assert.match((await response.json()).error.message, /do not intersect/);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls, 0);
});

test("adapter rejects recency values outside the supported date range", async () => {
  const { config, client } = fixture("tavily");
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({ results: [] });
  };
  try {
    const response = await handleConfiguredWebSearch(
      request({ search_query: [{ q: "docs", recency: 3651 }] }),
      config,
      client,
    );
    assert.equal(response.status, 400);
    assert.match((await response.json()).error.message, /between 0 and 3650/);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls, 0);
});

test("adapter treats a malformed successful provider response as unavailable", async () => {
  const { config, client } = fixture("exa");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ unexpected: true });
  try {
    const response = await handleConfiguredWebSearch(
      request({ search_query: [{ q: "docs" }] }),
      config,
      client,
    );
    assert.equal(response.status, 502);
    assert.equal(
      (await response.json()).error.code,
      "web_search_invalid_response",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("adapter rejects unsupported commands before calling a provider", async () => {
  const { config, client } = fixture("tavily");
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({ results: [] });
  };
  try {
    const response = await handleConfiguredWebSearch(
      request({ open: [{ ref_id: "https://example.com" }] }),
      config,
      client,
    );
    assert.equal(response.status, 400);
    assert.equal(
      (await response.json()).error.code,
      "unsupported_search_command",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls, 0);
});

test("adapter accepts and validates the Codex response length hint", async () => {
  const { config, client } = fixture("tavily");
  const originalFetch = globalThis.fetch;
  const providerBodies = [];
  globalThis.fetch = async (input, init) => {
    const upstream =
      input instanceof Request ? input : new Request(input, init);
    providerBodies.push(JSON.parse(await upstream.text()));
    return Response.json({ results: [] });
  };
  try {
    const accepted = await handleConfiguredWebSearch(
      request({ search_query: [{ q: "docs" }], response_length: "short" }),
      config,
      client,
    );
    assert.equal(accepted.status, 200);

    const rejected = await handleConfiguredWebSearch(
      request({ search_query: [{ q: "docs" }], response_length: "verbose" }),
      config,
      client,
    );
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).error.code, "invalid_search_request");
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(providerBodies.length, 1);
  assert.equal(Object.hasOwn(providerBodies[0], "response_length"), false);
});

test("adapter rejects unknown protocol fields instead of silently ignoring them", async () => {
  const { config, client } = fixture("tavily");
  const cases = [
    [
      request({ search_query: [{ q: "docs" }], future_command: [] }),
      "unsupported_search_command",
      "future_command",
    ],
    [
      request({ search_query: [{ q: "docs", future_filter: true }] }),
      "unsupported_search_command",
      "future_filter",
    ],
    [
      request(
        { search_query: [{ q: "docs" }] },
        { user_location: { country: "US" } },
      ),
      "unsupported_search_setting",
      "settings.user_location",
    ],
    [
      request(
        { search_query: [{ q: "docs" }] },
        { filters: { allowed_domains: ["docs.example"], future_filter: true } },
      ),
      "unsupported_search_setting",
      "settings.filters.future_filter",
    ],
  ];
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({ results: [] });
  };
  try {
    for (const [searchRequest, code, message] of cases) {
      const response = await handleConfiguredWebSearch(
        searchRequest,
        config,
        client,
      );
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.error.code, code);
      assert.match(
        body.error.message,
        new RegExp(message.replaceAll(".", "\\.")),
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls, 0);
});

test("adapter accepts and validates Codex search metadata", async () => {
  const { config, client } = fixture("exa");
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({ results: [] });
  };
  try {
    const liveResponse = await handleConfiguredWebSearch(
      request(
        { search_query: [{ q: "docs" }] },
        { allowed_callers: ["direct"], external_web_access: true },
      ),
      config,
      client,
    );
    assert.equal(liveResponse.status, 200);

    const cachedResponse = await handleConfiguredWebSearch(
      request(
        { search_query: [{ q: "docs" }] },
        { allowed_callers: ["direct"], external_web_access: false },
      ),
      config,
      client,
    );
    assert.equal(cachedResponse.status, 200);

    const invalidResponse = await handleConfiguredWebSearch(
      request(
        { search_query: [{ q: "docs" }] },
        { allowed_callers: ["unknown"], external_web_access: true },
      ),
      config,
      client,
    );
    assert.equal(invalidResponse.status, 400);
    assert.equal(
      (await invalidResponse.json()).error.code,
      "invalid_search_request",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls, 2);
});

test("Exa adapter falls back when highlights are empty", async () => {
  const { config, client } = fixture("exa");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      results: [
        {
          title: "Exa result",
          url: "https://result.example/exa",
          highlights: [],
          summary: "Summary fallback",
        },
      ],
    });
  try {
    const response = await handleConfiguredWebSearch(
      request({ search_query: [{ q: "docs" }] }),
      config,
      client,
    );
    assert.equal(response.status, 200);
    assert.equal(
      (await response.json()).results[0].snippet,
      "Summary fallback",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("adapter drops invalid, credentialed, and overlong provider URLs", async () => {
  const { config, client } = fixture("tavily");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      results: [
        { title: "relative", url: "/relative", content: "ignored" },
        { title: "script", url: "javascript:alert(1)", content: "ignored" },
        {
          title: "credentials",
          url: "https://user:secret@example.com",
          content: "ignored",
        },
        {
          title: "long",
          url: `https://example.com/${"a".repeat(4096)}`,
          content: "ignored",
        },
        { title: "valid", url: "https://example.com/result", content: "kept" },
      ],
    });
  try {
    const response = await handleConfiguredWebSearch(
      request({ search_query: [{ q: "docs" }] }),
      config,
      client,
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(
      body.results.map((result) => result.url),
      ["https://example.com/result"],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("adapter limits provider query concurrency", async () => {
  const { config, client } = fixture("exa");
  const originalFetch = globalThis.fetch;
  let active = 0;
  let maxActive = 0;
  globalThis.fetch = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return Response.json({ results: [] });
  };
  try {
    const response = await handleConfiguredWebSearch(
      request({
        search_query: [
          { q: "one" },
          { q: "two" },
          { q: "three" },
          { q: "four" },
        ],
      }),
      config,
      client,
    );
    assert.equal(response.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(SEARCH_PROVIDER_CONCURRENCY, 2);
  assert.equal(maxActive, SEARCH_PROVIDER_CONCURRENCY);
});

test("adapter rejects and cancels a response over the per-query budget", async () => {
  const { config, client } = fixture("tavily");
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new Uint8Array(MAX_SEARCH_PROVIDER_RESPONSE_BYTES + 1),
          );
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  try {
    const response = await handleConfiguredWebSearch(
      request({ search_query: [{ q: "docs" }] }),
      config,
      client,
    );
    assert.equal(response.status, 502);
    assert.equal(
      (await response.json()).error.code,
      "web_search_invalid_response",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(cancelled, true);
});

test("adapter enforces a total response budget across the query batch", async () => {
  const { config, client } = fixture("exa");
  const originalFetch = globalThis.fetch;
  const content = "x".repeat(
    Math.floor(MAX_SEARCH_BATCH_RESPONSE_BYTES / 4) + 64 * 1024,
  );
  globalThis.fetch = async (input, init) => {
    const upstream =
      input instanceof Request ? input : new Request(input, init);
    const { query } = JSON.parse(await upstream.text());
    return Response.json({
      results: [
        {
          title: query,
          url: `https://result.example/${query}`,
          text: content,
        },
      ],
    });
  };
  try {
    const response = await handleConfiguredWebSearch(
      request({
        search_query: [
          { q: "one" },
          { q: "two" },
          { q: "three" },
          { q: "four" },
        ],
      }),
      config,
      client,
    );
    assert.equal(response.status, 502);
    assert.equal(
      (await response.json()).error.code,
      "web_search_invalid_response",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("adapter returns non-JSON provider errors without calling an inference service", async () => {
  const { config, client } = fixture("tavily");
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (input, init) => {
    const upstream =
      input instanceof Request ? input : new Request(input, init);
    urls.push(upstream.url);
    return new Response("rate limited", { status: 429 });
  };
  try {
    const response = await handleConfiguredWebSearch(
      request({ search_query: [{ q: "docs" }] }),
      config,
      client,
    );
    assert.equal(response.status, 429);
    assert.equal(
      (await response.json()).error.code,
      "web_search_upstream_error",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(urls, ["https://tavily.example/search"]);
});

test("adapter preserves an upstream error status without buffering the error body", async () => {
  const { config, client } = fixture("tavily");
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("rate limited"));
      },
      cancel() {
        cancelled = true;
      },
    });
    return new Response(body, {
      status: 429,
      headers: { "content-length": String(8 * 1024 * 1024 + 1) },
    });
  };
  try {
    const response = await handleConfiguredWebSearch(
      request({ search_query: [{ q: "docs" }] }),
      config,
      client,
    );
    assert.equal(response.status, 429);
    assert.equal(
      (await response.json()).error.code,
      "web_search_upstream_error",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(cancelled, true);
});

test("adapter aborts sibling provider requests when one query fails", async () => {
  const { config, client } = fixture("exa");
  const originalFetch = globalThis.fetch;
  let firstResolve;
  let siblingAborted = false;
  globalThis.fetch = async (input, init) => {
    const upstream =
      input instanceof Request ? input : new Request(input, init);
    const body = JSON.parse(await upstream.text());
    if (body.query === "first") {
      firstResolve?.();
      return new Response("failed", { status: 503 });
    }
    await new Promise((resolve) => {
      firstResolve = resolve;
      init?.signal?.addEventListener(
        "abort",
        () => {
          siblingAborted = true;
          resolve();
        },
        { once: true },
      );
    });
    throw new Error("sibling request aborted");
  };
  try {
    const response = await handleConfiguredWebSearch(
      request({ search_query: [{ q: "first" }, { q: "second" }] }),
      config,
      client,
    );
    assert.equal(response.status, 503);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(siblingAborted, true);
});
