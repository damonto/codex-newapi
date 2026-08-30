# AGENTS.md

## Project overview

This repository contains a TypeScript Cloudflare Worker that serves as an AI API gateway for Codex and other clients.

## Runtime and tooling

- Use Node.js 24 or newer.
- Use `npm test` for the full test suite and `npm run typecheck` for TypeScript checks.
- Use `npm run lint` and `npm run format:check` before handing off changes. `lint` fails on warnings; `format:check` covers every tracked file except the generated ones listed in `.prettierignore`.
- Use `npm run config:validate -- config.json` before uploading configuration.
- Use `npx wrangler deploy --dry-run` to validate the Worker bundle without deploying.
- Do not commit `config.json`, `config.local.json`, `.dev.vars`, API keys, or upstream credentials.

## Configuration invariants

- `services[].models` contains only real upstream model names.
- `services[].keys` is non-empty. Each key has an ID unique within its service plus an explicit `priority` and `disabled` flag; the legacy service-level `api_key` field is not supported.
- Services do not declare a protocol. One upstream may serve both dialects, so the dialect is always derived per request; a `services[].protocol` field is rejected as unknown.
- `model_routes` is optional. Each route maps a client-facing model name to a real upstream `model` supported by at least one service.
- `model_routes.*.services` is optional. When present, every referenced service must exist and list the route's upstream model; routing intersects this list with the authenticated client API key's allowed services.
- `services[].model_routes` is optional. Each route maps a client-facing model name to a real upstream `model` listed in that service's `models`; service-level routes must not include a `services` field.
- Resolve routes per candidate service with the priority `services[].model_routes` > `api_keys[].model_routes` > global `model_routes`. The selected service's route determines the rewritten upstream model.
- `services[].retry` is optional and enables retries only when explicitly configured. Its `status_codes` and `delays_ms` arrays must both be empty or both be non-empty; the number of delays is the retry count.
- Client API keys may only reference declared services.
- Keep the JSON schema, `config.example.json`, parser validation, and tests consistent when changing configuration.

## Request and routing behavior

- Preserve request bodies, query strings, headers, and upstream responses whenever possible. Only replace the gateway Authorization header, rewrite a model field when a route is configured, inject the Claude Code identity when a service sets `inject_claude_code_identity`, and remove headers that become invalid after rewriting.
- Authenticate upstream requests with `Authorization: Bearer <key>` for every protocol. Client credentials, including `x-api-key`, are stripped before forwarding.
- Accept client credentials from either `Authorization: Bearer` or `x-api-key`, since the Claude Code SDK sends the latter.
- Return Anthropic-shaped errors to Anthropic-protocol clients, with the `type` derived from the HTTP status via the documented Anthropic set. Diagnostic `code` values are OpenAI-only and remain in the request log.
- Inject the Claude Code identity headers and `system` marker on both `/v1/messages` and `/v1/messages/count_tokens`, but the `metadata.user_id` field only on `/v1/messages`; `count_tokens` does not accept `metadata`.
- Derive the injected `device_id` and `session_id` from the client API key and session so they stay stable across turns instead of changing per request.
- Resolve the affinity session id from the `session-id` header, then `client_metadata.session_id`, then the Anthropic `metadata.user_id` JSON payload, then the `alpha/search` top-level `id`. Claude Code carries its session only in `metadata.user_id`.
- Select services by descending priority, then configuration order, while skipping services in cooldown.
- Within the selected service, use the highest-priority enabled key and break ties by configuration order. Key switching is configuration-driven, not automatic.
- Apply only the selected service's configured retry policy. Retries resend the same request with the same selected key; they never switch keys or services, and the final upstream response is returned unchanged.
- Do not add retries beyond the configured policy or fallback to another service after an upstream request has started unless the user explicitly requests that behavior.
- Health tracking counts a failure streak only when 10 consecutive failed requests occur within a five-minute window. A success resets the streak; the cooldown lasts 30 minutes and persists in Durable Object storage across instance eviction and deployments.
- Resolve the request dialect with `requestProtocol(request, endpoint)`: the `anthropic-version` header first, then the endpoint's own dialect, then a Claude user agent for the dialect-neutral endpoints (`models`, `health`, `sessions`). `protocol.ts` owns the endpoint-to-dialect map; do not re-derive it from the path elsewhere.
- Failure statuses follow that request dialect. OpenAI counts 400 and 503 against the service and 402 and 403 against the key; Anthropic counts 500, 502, 503, and 529 against the service and 401 and 403 against the key. A status maps to at most one scope, so one response never records both.
- The Responses WebSocket Durable Object accepts only Codex `response.create` frames, so every status it classifies is OpenAI-shaped.
- `GET /health` and `/v1/health` list current inference cooldowns visible to the authenticated client API key. `DELETE /health/{service_id}` and `/v1/health/{service_id}` manually clear one inference cooldown. `scope=catalog` selects catalog health for either operation.
- Keep catalog/model-list health separate from inference health. Catalog failures must not change inference routing health.
- Schedule health writes with `ExecutionContext.waitUntil` in Workers; direct test callers may use synchronous fallback behavior.
- User-Agents containing `codex` receive the Codex `{models: [...]}` shape; other clients receive the standard model-list shape.

## Cloudflare deployment

- `wrangler.jsonc` contains a placeholder KV namespace ID. Replace it with an ID from the target Cloudflare account before deployment.
- Use Cloudflare Workers Builds Git integration for automatic deployments from `main`; do not add a GitHub Actions deployment workflow unless the user explicitly requests one.
- Upload the validated JSON configuration to the `CODY_CONFIG_KV` binding after creating the namespace.
- Keep Durable Object migrations compatible with the deployed Worker; do not rename the `ServiceHealth` class without a migration plan.
- Model catalog fetches use a three-second timeout and cache successful aggregates for a short, configurable isolate-local TTL.
- Strip proxy metadata, client credentials, and hop-by-hop headers before forwarding; preserve ordinary application headers.

## Change and verification guidelines

Prefer small, focused changes. Add or update tests for routing, configuration validation, model aggregation, and health-window behavior. Run the full test suite, typecheck, configuration validation, and a Wrangler dry-run before handing off changes.
