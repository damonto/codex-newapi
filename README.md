# Codex NewAPI Gateway

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/damonto/codex-newapi)

An OpenAI-compatible aggregation gateway for Cloudflare Workers. It routes requests across multiple NewAPI-compatible services, restricts services by client API key, supports one-to-one model aliases, and exposes Codex-compatible model metadata.

## Features

- Supports `/models`, `/v1/models`, `/responses`, `/v1/responses`, `/chat/completions`, and `/v1/chat/completions`.
- Selects the highest-priority configured service that supports the requested model and is not cooling down. Configuration order breaks priority ties.
- Keeps `codex-auto-review` as a separate fixed service/model mapping.
- Treats `model_aliases` as optional. When omitted, ordinary models are routed using their requested names.
- Requires `services[].models` and `codex_auto_review.model` to contain real upstream model names. Client aliases are configured separately.
- Counts upstream network errors and non-2xx responses as failures. A service enters a 30-minute cooldown only after 10 consecutive failed requests whose entire streak starts and finishes within one five-minute window. Any successful request resets the streak.
- Tracks model-catalog health independently from inference health, so a directory outage cannot cool down inference routing.
- Does not retry or switch services after an upstream request has started. The upstream response is returned unchanged.
- Preserves ordinary application headers while replacing `Authorization` and removing hop-by-hop, proxy-tracing, cookie, and client-credential headers before forwarding.
- Returns `{ "models": [...] }` to User-Agents containing `codex` and the standard `{ "object": "list", "data": [...] }` shape to other clients.
- Uses the bundled Codex model catalog for the Codex response format. Only exact catalog matches are returned.
- Keeps health state in Durable Object memory. It is intentionally not persisted and may reset when the object restarts.

## Runtime logging

The Worker emits structured JSON logs for request lifecycle, authentication, model discovery, route selection, upstream latency/status, configuration refreshes, and health cooldowns. Each request carries a `request_id` through the related events so a complete request can be traced in Cloudflare Logs. Logs never include API keys, `Authorization` headers, request bodies, or upstream response bodies. Set the `LOG_LEVEL` Worker variable to `info` (default), `warn`, `error`, or `off`; `warn` or `error` is recommended for production when full request tracing is not needed. Known credential fields and Bearer/token values in error messages are redacted at the logging boundary.

Codex's third-party API provider can request `/models` below its configured provider base URL. Therefore a gateway base URL ending in `/v1` is accessed as `/v1/models`. Official clients commonly use a User-Agent such as `codex_cli_rs/...`; that request receives the Codex model shape. Codex may also use its bundled catalog and an explicit `model`, so a model-list request is not guaranteed on every startup.

## Requirements

- Node.js 22 or newer
- A Cloudflare account with Workers and KV access

## Configuration

Copy `config.example.json` to `config.json` and edit it. The real configuration is uploaded as one `gateway-config` value in Workers KV. `config.json` is ignored by Git.

```json
{
  "services": [
    {
      "id": "primary",
      "base_url": "https://newapi.example.com/v1",
      "api_key": "sk-upstream",
      "priority": 100,
      "models": ["grok-4.5"]
    }
  ],
  "api_keys": [
    {
      "api_key": "sk-client",
      "services": ["primary"]
    }
  ],
  "model_aliases": {
    "gpt-5.6-sol": "grok-4.5"
  },
  "codex_auto_review": {
    "service": "primary",
    "model": "grok-4.5"
  }
}
```

`model_aliases` may be omitted. If present, each value must be a real model listed by at least one service. For example, a client request for `gpt-5.6-sol` is forwarded upstream with `model: grok-4.5`. The alias is an entry-point name and is never sent to the upstream service.

`codex_auto_review` remains independent from `model_aliases` and pins `codex-auto-review` to one service and one real upstream model. It must be configured even when no ordinary aliases are used.

## Deploy

The badge at the top opens Cloudflare's official Deploy to Workers flow for this repository. The repository intentionally contains a placeholder KV namespace ID, because the namespace belongs to your Cloudflare account. Create or select your namespace and replace the ID before the first production deployment.

For a manual deployment:

```bash
npm install
npx wrangler login
npx wrangler kv namespace create CONFIG_KV
```

Put the returned namespace ID in `wrangler.jsonc` under `kv_namespaces[0].id`, then validate and upload the configuration:

```bash
npm run config:validate -- config.json
npm run config:put -- config.json
npm run deploy
```

For local development, use the local KV store:

```bash
npm run config:put -- config.json --local
npm run dev
```

The Worker caches the KV configuration for 10 seconds by default. Updating the KV value does not require a Worker redeploy, although KV propagation can take a short time.

The `/models` and `/v1/models` aggregations use an isolate-local successful-response cache for 30 seconds by default. Set `MODELS_CACHE_TTL_SECONDS` to `0` to disable it (values above five minutes are capped). Concurrent misses are coalesced into one upstream fan-out. Each upstream catalog request has an independent three-second timeout. Catalog health is tracked separately from inference health, so a temporary directory failure does not cool down an inference route.

## Codex provider configuration

```toml
model = "gpt-5.6-sol"
model_provider = "gateway"

[model_providers.gateway]
name = "Gateway"
base_url = "https://codex-newapi-gateway.example.workers.dev/v1"
env_key = "GATEWAY_API_KEY"
wire_api = "responses"
```

Set `GATEWAY_API_KEY` to one of the client keys configured in `api_keys`.

## Commands

Synchronize `src/codex-models.json` from the latest stable `openai/codex` release. Set `GITHUB_TOKEN` or `GH_TOKEN` when authenticated GitHub API access is needed:

```bash
npm run models:sync
```

```bash
npm test
npm run typecheck
npm run config:validate -- config.example.json
npx wrangler deploy --dry-run
```
