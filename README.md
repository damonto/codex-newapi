# Codex NewAPI Gateway

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/damonto/codex-newapi)

Use several NewAPI services through one Cloudflare Workers endpoint. It works with Codex and other OpenAI-compatible clients.

## What it does

- Combines multiple NewAPI services behind one address.
- Routes models by priority and controls access with client API keys.
- Supports model aliases and Codex auto review.
- Supports Codex Image Gen through configured `gpt-image-2` services.
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
      "api_key": "sk-upstream",
      "disabled": false,
      "priority": 100,
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
  "model_aliases": {
    "gpt-5.6-sol": "grok-4.5"
  },
  "codex_auto_review": {
    "service": "primary",
    "model": "grok-4.5"
  }
}
```

- `services`: upstream services and the models they provide. Higher priority wins.
- `api_keys`: keys used by your clients and the services each key may access.
- `model_aliases`: optional client-facing names for upstream models.
- `codex_auto_review`: service and model used by Codex auto review.
- `retry`: optional status codes and delays. Each delay adds one retry; omitting this field disables retries.

To use Image Gen, the client API key must have access to an enabled service whose `models` list includes `gpt-image-2`.

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
requires_openai_auth = true
```

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
