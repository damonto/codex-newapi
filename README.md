# Cody Gateway

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/damonto/cody)

Use several upstream services through one Cloudflare Workers endpoint. It works with Codex and other OpenAI-compatible clients.

## What it does

- Combines multiple upstream services behind one address.
- Routes models by priority and controls access with client API keys.
- Supports multiple upstream API keys per service with independent cooldowns.
- Supports client-facing model routes with optional service constraints.
- Supports Codex Image Gen through configured `gpt-image-2` services.
- Proxies Codex Responses WebSockets and remote compaction, and can proxy or adapt standalone search.
- Keeps a session on the same service/key while it remains the highest-priority available target.
- Lists and clears session bindings through authenticated management endpoints.
- Can retry selected status codes with a separate policy for each service.

## Quick setup

You need Node.js 24 or newer and a Cloudflare account with Workers and KV.

Install the project, sign in, and create a KV namespace:

```bash
npm install
npx wrangler login
npx wrangler kv namespace create CODY_CONFIG_KV
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
      "base_url": "https://api.example.com/v1",
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
      "id": "client",
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
  },
  "web_search": {
    "mode": "proxy"
  }
}
```

- `services`: upstream services and the models they provide. Higher priority wins.
- `services[].keys`: upstream credentials for one service. The highest-priority available key is used; equal priorities follow configuration order.
- `services[].supports_websocket`: whether the service can receive Responses WebSocket connections. Defaults to `false` when omitted.
- `services[].supports_web_search`: whether the service can receive standalone `/alpha/search` requests in `proxy` mode. Defaults to `false` when omitted.
- `services[].inject_claude_code_identity`: injects the Claude Code SDK client identity into `/v1/messages` requests routed through this service. This adds the `claude-code-20250219` beta header, the CLI `user-agent` and `x-app` headers, the `system` agent marker, and `metadata.user_id` (a JSON string with `device_id`/`session_id` when absent). Defaults to `false` when omitted; enable it only for Anthropic-compatible gateways that require Claude Code clients.
- `api_keys`: keys used by your clients and the services each key may access. Each entry requires a globally unique, non-sensitive `id`. An entry may also include optional `model_routes` that override the global routes for that key.
- `model_routes`: optional client-facing routes. `model` is the real upstream model; optional `services` limits the route to those services. Each `api_keys[]` entry may provide its own `model_routes`; per-key entries override the global route for the same client-facing model, while unconfigured models fall back to the global routes.
- `web_search.mode`: selects standalone search behavior. `proxy` (the default) forwards `/v1/alpha/search` to a `supports_web_search` upstream service; `tavily` and `exa` call the configured provider directly and never fall back to proxy.
- `web_search.base_url`: optional provider base URL. Defaults to `https://api.tavily.com` or `https://api.exa.ai` for adapter modes.
- `web_search.api_key`: provider credential. Keep it in the KV configuration and out of source-controlled example files.
- `web_search.max_results`: maximum results requested from the configured adapter. Tavily accepts 0 to 20 (default 5); Exa accepts 1 to 100 (default 10).
- `retry`: optional status codes and delays. Each delay adds one retry; omitting this field disables retries.

Existing configurations must add an `id` to every `api_keys` entry before they can be validated or loaded.

When a route omits `services`, all client-authorized services that list its upstream model are eligible. When `services` is present, it is intersected with the client API key's allowed services. Unconfigured model names are forwarded directly.

A client API key can override individual global routes by adding `model_routes` to its `api_keys` entry:

```json
{
  "api_keys": [
    {
      "id": "client-a",
      "api_key": "sk-gateway-client-a",
      "services": ["primary", "secondary"],
      "model_routes": {
        "gpt-5.6-sol": {
          "model": "grok-4.5",
          "services": ["secondary"]
        }
      }
    }
  ]
}
```

The per-key map uses the same shape and validation as the global `model_routes` and is merged per model: a model configured for the key overrides the global route of the same name, and every other model falls back to the global map. Per-key routes affect both request routing and the `/v1/models` catalog shown to that client.

In `proxy` mode, standalone search selects only services with `supports_web_search: true`. Responses WebSocket connections select only services with `supports_websocket: true`. These filters are applied before priority selection and session affinity; ordinary HTTP Responses and compact requests do not require either capability.

Services are considered by highest available priority, with equal-priority services following configuration order. A session ID from the `session-id` header or `client_metadata.session_id` keeps subsequent requests on the same service/key while that target remains eligible, healthy, and at the highest available priority. If a higher-priority service becomes available, the next request moves the binding to the highest-priority service and one of its highest-priority keys. If the current service remains highest priority but a higher-priority key becomes available within it, the binding moves to that key. Equal priorities do not move an existing binding. In `proxy` mode, standalone search also accepts its top-level `id` as the lowest-priority session identifier. `thread-id` is not used for affinity.

### Standalone web search

Choose exactly one global search mode. Omitting `web_search` preserves the existing `proxy` behavior.

To forward `/v1/alpha/search` unchanged to an upstream, enable search on the eligible services and select `proxy`:

```json
{
  "web_search": {
    "mode": "proxy"
  }
}
```

At least one client-authorized service for the requested model must also set `supports_web_search: true`.

To adapt Codex search requests to Tavily:

```json
{
  "web_search": {
    "mode": "tavily",
    "api_key": "tvly-your-private-key",
    "max_results": 5
  }
}
```

To adapt them to Exa:

```json
{
  "web_search": {
    "mode": "exa",
    "api_key": "your-private-exa-key",
    "max_results": 10
  }
}
```

Adapter modes call only the selected provider. They do not try an upstream service after a 404 or any other provider failure, and they do not switch between Tavily and Exa. `base_url` may be set for a compatible proxy; otherwise it defaults to `https://api.tavily.com` or `https://api.exa.ai`.

Tavily and Exa modes support `commands.search_query` with up to four queries, including per-query `domains` and `recency` from 0 to 3650 days, plus global allowed/blocked domain filters. The Codex `response_length` hint is accepted and validated as `short`, `medium`, or `long`; provider result count and cost remain controlled by `web_search.max_results`. Tavily accepts up to 300 included and 150 excluded domains; Exa accepts up to 1200 of each. Codex commands that require a full browsing backend, including `image_query`, `open`, `click`, `find`, and `screenshot`, return `unsupported_search_command`. Unknown command, query, setting, and filter fields are rejected instead of being silently ignored. Codex `allowed_callers` and `external_web_access` metadata are validated but do not change the provider selected by the gateway configuration. The requested model must still be available to the authenticated client API key, but adapter requests do not participate in service health, retries, or session affinity.

Adapter responses are limited to 2 MiB per query and 4 MiB for the complete request batch. At most two provider queries run concurrently; crossing either response budget cancels the remaining batch and returns `web_search_invalid_response`.

HTTP 402 and 403 responses immediately cool only the selected key for 30 minutes. Configured retries still use that same key and never switch service/key during the current request; the cooldown affects later requests. Service and key inference cooldowns can be listed with `GET /health`, cleared with `DELETE /health/{service_id}` or `DELETE /health/{service_id}/{key_id}`, and isolated catalog cooldowns use `scope=catalog`.

Session bindings are isolated by the authenticated client API key and can be managed through both versioned and unversioned paths:

- `GET /sessions` lists bindings. `limit` defaults to 100 and may be set from 1 to 1000; pass the returned opaque `next_cursor` as `cursor` to continue.
- `DELETE /sessions` clears all bindings visible to the authenticated API key and returns the number deleted.
- `DELETE /sessions/{session_id}` clears one URL-encoded session ID. Missing bindings return `deleted: 0`.

Every service must declare a non-empty `keys` array, although all entries may be disabled to take that service out of routing. The former `services[].api_key` field is no longer accepted.

Client key IDs appear as `client_key_id` in authenticated request summaries. Upstream key IDs continue to appear in routing and upstream log sections. Use descriptive, non-sensitive labels and never copy credential values into `id`.

To use Image Gen, the client API key must be able to route `gpt-image-2`, either directly or through global or per-key `model_routes`.

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
base_url = "https://cody.example.workers.dev/v1"
wire_api = "responses"
http_headers = { "x-openai-actor-authorization" = "cody" }
```

To use the Image Gen tool, configure `http_headers = { "x-openai-actor-authorization" = "cody" }` for the provider.

### Let Codex refresh the model catalog

The basic provider configuration above is enough when `model` is set explicitly, but it does not
make Codex fetch this gateway's model catalog. To make Codex request `GET /v1/models`, add
command-backed authentication to the provider. The command output becomes the Bearer token used
for the catalog request and other requests sent through this provider:

```toml
model = "gpt-5.6-sol"
model_provider = "gateway"

[model_providers.gateway]
name = "Gateway"
base_url = "https://cody.example.workers.dev/v1"
wire_api = "responses"
http_headers = { "x-openai-actor-authorization" = "cody" }

[model_providers.gateway.auth]
command = "printenv"
args = ["OPENAI_API_KEY"]
timeout_ms = 5000
refresh_interval_ms = 300000
```

Set the environment variable before starting Codex so it is available to the Codex process:

```bash
export OPENAI_API_KEY="your-gateway-client-key"
codex
```

`printenv` must print only the gateway client key to stdout. Another credential helper can be used
instead as long as it has the same output behavior.

The value must match an `api_keys[].api_key` entry in this gateway's private `config.json`. Do not
put an upstream service key or an unrelated OpenAI/ChatGPT credential there, and never commit the
key.

Keep `requires_openai_auth` omitted (its default is `false`) and do not combine command-backed
authentication with `env_key` or `experimental_bearer_token`. Command-backed authentication makes
Codex refresh the remote model catalog, while the `x-openai-actor-authorization` header continues
to enable the Codex Image Gen and standalone Search integrations. Codex caches the command result
for `refresh_interval_ms` and runs the command again after that interval expires.

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
