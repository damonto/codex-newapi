# AGENTS.md

## Project overview

This repository contains a TypeScript Cloudflare Worker that aggregates multiple OpenAI-compatible NewAPI services for Codex and other clients.

## Runtime and tooling

- Use Node.js 24 or newer.
- Use `npm test` for the full test suite and `npm run typecheck` for TypeScript checks.
- Use `npm run config:validate -- config.json` before uploading configuration.
- Use `npx wrangler deploy --dry-run` to validate the Worker bundle without deploying.
- Do not commit `config.json`, `config.local.json`, `.dev.vars`, API keys, or upstream credentials.

## Configuration invariants

- `services[].models` contains only real upstream model names.
- `model_aliases` is optional. Its values must be real upstream model names supported by at least one service.
- `codex_auto_review` is separate from `model_aliases` and pins `codex-auto-review` to one configured service and real model.
- Client API keys may only reference declared services.
- Keep the JSON schema, `config.example.json`, parser validation, and tests consistent when changing configuration.

## Request and routing behavior

- Preserve request bodies, query strings, headers, and upstream responses whenever possible. Only replace the gateway Authorization header, rewrite a model field when an alias is configured, and remove headers that become invalid after rewriting.
- Select services by descending priority, then configuration order, while skipping services in cooldown.
- Do not add per-request retries or fallback after an upstream request has started unless the user explicitly requests that behavior.
- Health tracking counts a failure streak only when 10 consecutive failed requests occur within a five-minute window. A success resets the streak; the cooldown lasts 30 minutes and persists in Durable Object storage across instance eviction and deployments.
- `GET /health` and `/v1/health` list current inference cooldowns visible to the authenticated client API key. `DELETE /health/{service_id}` and `/v1/health/{service_id}` manually clear one inference cooldown. `scope=catalog` selects catalog health for either operation.
- Keep catalog/model-list health separate from inference health. Catalog failures must not change inference routing health.
- Schedule health writes with `ExecutionContext.waitUntil` in Workers; direct test callers may use synchronous fallback behavior.
- User-Agents containing `codex` receive the Codex `{models: [...]}` shape; other clients receive the standard model-list shape.

## Cloudflare deployment

- `wrangler.jsonc` contains a placeholder KV namespace ID. Replace it with an ID from the target Cloudflare account before deployment.
- Use Cloudflare Workers Builds Git integration for automatic deployments from `main`; do not add a GitHub Actions deployment workflow unless the user explicitly requests one.
- Upload the validated JSON configuration to the `CODEX_NEWAPI_CONFIG_KV` binding after creating the namespace.
- Keep Durable Object migrations compatible with the deployed Worker; do not rename the `ServiceHealth` class without a migration plan.
- Model catalog fetches use a three-second timeout and cache successful aggregates for a short, configurable isolate-local TTL.
- Strip proxy metadata, client credentials, and hop-by-hop headers before forwarding; preserve ordinary application headers.

## Change and verification guidelines

Prefer small, focused changes. Add or update tests for routing, configuration validation, model aggregation, and health-window behavior. Run the full test suite, typecheck, configuration validation, and a Wrangler dry-run before handing off changes.
