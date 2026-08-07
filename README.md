# Codex NewAPI Gateway

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/damonto/codex-newapi)

Use several NewAPI services through one Cloudflare Workers endpoint. It works with Codex and other OpenAI-compatible clients.

## What it does

- Combines multiple NewAPI services behind one address.
- Routes models by priority and controls access with client API keys.
- Supports multiple upstream API keys per service with independent cooldowns.
- Supports client-facing model routes with optional service constraints.
- Supports Codex Image Gen through configured `gpt-image-2` services.
- Proxies Codex Responses WebSockets, standalone search, and remote compaction.
- Keeps a session on the same service/key while it remains the highest-priority available target.
- Lists and clears session bindings through authenticated management endpoints.
- Can retry selected status codes with a separate policy for each service.

## Quick setup

You need Node.js 24 or newer and a Cloudflare account with Workers and KV.

Install the project, sign in, and create a KV namespace:

```bash
npm install
npx wrangler login
npx wrangler kv namespace create CODEX_NEWAPI_CONFIG_KV
```

Put the returned namespace ID in `wrangler.jsonc`, replacing the placeholder KV ID.

Create and edit your private configuration:

```bash
cp config.example.json config.json
```

Then validate, upload, and deploy:

```bash
npm run config:validate -- config.json
npm run config:put -- config.json
npm run deploy
```

`config.json` contains credentials and is ignored by Git. Never commit it.

## Configuration

```json
{
  "services": [
    {
      "id": "primary",
      "base_url": "https://newapi.example.com/v1",
      "keys": [
        {
          "id": "primary-key",
          "api_key": "sk-upstream-primary",
          "disabled": false,
          "priority": 100
        },
        {
          "id": "backup-key",
          "api_key": "sk-upstream-backup",
          "disabled": true,
          "priority": 50
        }
      ],
      "disabled": false,
      "priority": 100,
      "supports_websocket": true,
      "supports_web_search": true,
      "models": ["grok-4.5", "gpt-image-2"],
      "retry": {
        "status_codes": [429],
        "delays_ms": [250, 500, 1000]
      }
    }
  ],
  "api_keys": [
    {
      "api_key": "sk-client",
      "services": ["primary"]
    }
  ],
  "model_routes": {
    "gpt-5.6-sol": {
      "model": "grok-4.5"
    },
    "codex-auto-review": {
      "model": "grok-4.5",
      "services": ["primary"]
    }
  }
}
```

- `services`: upstream services and the models they provide. Higher priority wins.
- `services[].keys`: upstream credentials for one service. The highest-priority available key is used; equal priorities follow configuration order.
- `services[].supports_websocket`: whether the service can receive Responses WebSocket connections. Defaults to `false` when omitted.
- `services[].supports_web_search`: whether the service can receive standalone `/alpha/search` requests. Defaults to `false` when omitted.
- `api_keys`: keys used by your clients and the services each key may access.
- `model_routes`: optional client-facing routes. `model` is the real upstream model; optional `services` limits the route to those services.
- `retry`: optional status codes and delays. Each delay adds one retry; omitting this field disables retries.

When a route omits `services`, all client-authorized services that list its upstream model are eligible. When `services` is present, it is intersected with the client API key's allowed services. Unconfigured model names are forwarded directly.

Standalone search selects only services with `supports_web_search: true`. Responses WebSocket connections select only services with `supports_websocket: true`. These filters are applied before priority selection and session affinity; ordinary HTTP Responses and compact requests do not require either capability.

Services are considered by highest available priority, with equal-priority services following configuration order. A session ID from the `session-id` header or `client_metadata.session_id` keeps subsequent requests on the same service/key while that target remains eligible, healthy, and at the highest available priority. If a higher-priority service becomes available, the next request moves the binding to the highest-priority service and one of its highest-priority keys. If the current service remains highest priority but a higher-priority key becomes available within it, the binding moves to that key. Equal priorities do not move an existing binding. Standalone search also accepts its top-level `id` as the lowest-priority session identifier. `thread-id` is not used for affinity.

HTTP 402 and 403 responses immediately cool only the selected key for 30 minutes. Configured retries still use that same key and never switch service/key during the current request; the cooldown affects later requests. Service and key inference cooldowns can be listed with `GET /health`, cleared with `DELETE /health/{service_id}` or `DELETE /health/{service_id}/{key_id}`, and isolated catalog cooldowns use `scope=catalog`.

Session bindings are isolated by the authenticated client API key and can be managed through both versioned and unversioned paths:

- `GET /sessions` lists bindings. `limit` defaults to 100 and may be set from 1 to 1000; pass the returned opaque `next_cursor` as `cursor` to continue.
- `DELETE /sessions` clears all bindings visible to the authenticated API key and returns the number deleted.
- `DELETE /sessions/{session_id}` clears one URL-encoded session ID. Missing bindings return `deleted: 0`.

Every service must declare a non-empty `keys` array, although all entries may be disabled to take that service out of routing. The former `services[].api_key` field is no longer accepted.

Key IDs appear in structured logs. Use descriptive, non-sensitive labels and never copy credential values into `id`.

To use Image Gen, the client API key must be able to route `gpt-image-2`, either directly or through `model_routes`.

The gateway accepts both versioned and unversioned forms of these inference paths:

- `POST /responses`
- `GET /responses` with a WebSocket upgrade
- `POST /responses/compact`
- `POST /alpha/search`
- `POST /chat/completions`
- `POST /images/generations`
- `POST /images/edits`

After changing `config.json`, upload it again. A Worker redeploy is not required:

```bash
npm run config:validate -- config.json
npm run config:put -- config.json
```

## Use with Codex

Add a provider to `~/.codex/config.toml`:

```toml
model = "gpt-5.6-sol"
model_provider = "gateway"

[model_providers.gateway]
name = "Gateway"
base_url = "https://codex-newapi.example.workers.dev/v1"
wire_api = "responses"
http_headers = { "x-openai-actor-authorization" = "codex-newapi" }
```

To use the Image Gen tool, configure `http_headers = { "x-openai-actor-authorization" = "codex-newapi" }` for the provider.

## Automatic deployment

Import the repository with [Cloudflare Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) to deploy every push to `main`. Use `npm test && npm run typecheck` as the build command and `npm run deploy` as the deploy command.

## Local development

```bash
npm run config:put -- config.json --local
npm run dev
```

Run checks before deploying:

```bash
npm test
npm run typecheck
npm run config:validate -- config.example.json
npx wrangler deploy --dry-run
```
