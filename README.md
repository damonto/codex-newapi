# Codex NewAPI Gateway

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/damonto/codex-newapi)

An OpenAI-compatible aggregation gateway for Cloudflare Workers. It routes requests across multiple NewAPI-compatible services, restricts services by client API key, supports one-to-one model aliases, and exposes Codex-compatible model metadata.

## Features

- Supports `/models`, `/v1/models`, `/responses`, `/v1/responses`, `/chat/completions`, `/v1/chat/completions`, and authenticated health status/reset endpoints.
- Rejects inference request bodies larger than 64 MiB with HTTP 413. The limit is enforced against both `Content-Length` and the bytes actually read from the stream.
- Selects the highest-priority configured service that supports the requested model and is not cooling down. Configuration order breaks priority ties.
- Requires every service to declare `disabled`; a service with `disabled: true` is excluded from inference routing and model aggregation.
- Rejects configuration fields that are not declared by `config.schema.json`.
- Keeps `codex-auto-review` as a separate fixed service/model mapping.
- Treats `model_aliases` as optional. When omitted, ordinary models are routed using their requested names.
- Requires `services[].models` and `codex_auto_review.model` to contain real upstream model names. Client aliases are configured separately.
- Counts upstream network errors and HTTP 400 or 503 responses as failures. Other HTTP statuses do not change the failure streak. A service enters a 30-minute cooldown only after 10 consecutive failed requests whose entire streak starts and finishes within one five-minute window. Any successful request resets the streak.
- Tracks model-catalog health independently from inference health, so a directory outage cannot cool down inference routing.
- Does not retry or switch services after an upstream request has started. The upstream response is returned unchanged.
- Preserves ordinary application headers while replacing `Authorization` and removing hop-by-hop, proxy-tracing, cookie, and client-credential headers before forwarding.
- Returns `{ "models": [...] }` to User-Agents containing `codex` and the standard `{ "object": "list", "data": [...] }` shape to other clients.
- Uses the bundled Codex model catalog for the Codex response format. Only exact catalog matches are returned.
- Persists health state in Durable Object storage, so a 30-minute cooldown survives instance eviction and Worker deployments.

## Runtime logging

The Worker emits structured JSON logs for request lifecycle, authentication, model discovery, route selection, upstream latency/status, configuration refreshes, and health cooldowns. Each request carries a `request_id` through the related events so a complete request can be traced in Cloudflare Logs. Logs never include API keys, `Authorization` headers, request bodies, or upstream response bodies. Set the `LOG_LEVEL` Worker variable to `info` (default), `warn`, `error`, or `off`; `warn` or `error` is recommended for production when full request tracing is not needed. Known credential fields and Bearer/token values in error messages are redacted at the logging boundary.

Codex's third-party API provider can request `/models` below its configured provider base URL. Therefore a gateway base URL ending in `/v1` is accessed as `/v1/models`. Official clients commonly use a User-Agent such as `codex_cli_rs/...`; that request receives the Codex model shape. Codex may also use its bundled catalog and an explicit `model`, so a model-list request is not guaranteed on every startup.

## Requirements

- Node.js 24 or newer
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
      "disabled": false,
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

Every service must explicitly set `disabled` to a boolean. Use `false` to make the service available and `true` to stop routing requests to it and exclude it from `/models` without deleting its configuration.

Configuration objects are strict: unknown root, service, client-key, and `codex_auto_review` fields are rejected instead of being silently ignored.

`model_aliases` may be omitted. If present, each value must be a real model listed by at least one service. For example, a client request for `gpt-5.6-sol` is forwarded upstream with `model: grok-4.5`. The alias is an entry-point name and is never sent to the upstream service.

`codex_auto_review` remains independent from `model_aliases` and pins `codex-auto-review` to one service and one real upstream model. It must be configured even when no ordinary aliases are used.

## Inspect or clear cooldowns

List services currently cooling down and accessible to the configured client API key:

```bash
curl \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  "https://codex-newapi-gateway.example.workers.dev/v1/health"
```

The response uses `{ "object": "list", "scope": "inference", "data": [...] }`; every item contains `service_id`, `failures`, and `cooling_until`. Add `?scope=catalog` to inspect model-catalog health instead.

Use a configured client API key to clear the inference health state for one of the services that key can access:

```bash
curl -X DELETE \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  "https://codex-newapi-gateway.example.workers.dev/v1/health/newapi-primary"
```

Add `?scope=catalog` to clear the service's model-catalog health instead. Listing and clearing never expose or modify services that the authenticated client key cannot access.

## Deploy

### Cloudflare Git deployment (recommended)

The badge at the top opens Cloudflare's official deployment flow. You can also import the repository directly with [Cloudflare Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/). Workers Builds connects the Worker to GitHub and automatically builds and deploys every new commit pushed to the production branch. A GitHub Actions workflow is not required.

First, create the KV namespace once from a local checkout:

```bash
npm install
npx wrangler login
npx wrangler kv namespace create CODEX_NEWAPI_CONFIG_KV
```

Replace the placeholder `kv_namespaces[0].id` in `wrangler.jsonc` with the returned namespace ID and push that change to GitHub. A KV namespace ID identifies a resource and is safe to commit; the gateway API keys and upstream credentials are not. Keep those credentials only in the ignored `config.json` file and in Workers KV.

Validate and upload the gateway configuration to the namespace:

```bash
cp config.example.json config.json
# Edit config.json before continuing.
npm run config:validate -- config.json
npm run config:put -- config.json
```

Then configure the Git deployment in the Cloudflare dashboard:

1. Go to **Workers & Pages** > **Create application** > **Import a repository**.
2. Authorize the **Cloudflare Workers and Pages** GitHub application and select this repository.
3. Use `main` as the production branch and `/` as the root directory.
4. Ensure the Cloudflare Worker name is `codex-newapi`, matching `wrangler.jsonc`.
5. Set the build command to `npm test && npm run typecheck && npm run config:validate -- config.example.json && npx wrangler types --check`.
6. Set the deploy command to `npm run deploy` and select **Save and Deploy**.

Cloudflare uses the `.node-version` file to select Node.js 24. After the connection is active, every push to `main` runs the checks and deploys the new Worker version automatically. Cloudflare can also create preview versions for non-production branches when branch builds are enabled.

Code deployments do not overwrite the existing KV contents. Updating `config.json` is a separate operation and does not require a code commit or Worker redeploy:

```bash
npm run config:validate -- config.json
npm run config:put -- config.json
```

The Worker reloads the KV configuration after its short configuration-cache TTL. Because `config.json` is intentionally ignored by Git, Cloudflare Workers Builds never receives or uploads the gateway credentials.

### Manual deployment

For a manual deployment:

```bash
npm install
npx wrangler login
npx wrangler kv namespace create CODEX_NEWAPI_CONFIG_KV
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

The `/models` and `/v1/models` aggregations use an isolate-local successful-response cache for 30 seconds by default. Set `MODELS_CACHE_TTL_SECONDS` to `0` to disable it (values above five minutes are capped). Concurrent misses are coalesced into one upstream fan-out. At most six upstream catalog requests run concurrently; each has an independent three-second timeout and an 8 MiB response-body limit. Unused error bodies are cancelled. Catalog health is tracked separately from inference health, so a temporary directory failure does not cool down an inference route.

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
npx wrangler types --check
npx wrangler deploy --dry-run
```
