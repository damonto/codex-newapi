import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        serviceBindings: {
          TEST_UPSTREAM: "test-upstream",
        },
        workers: [{
          name: "test-upstream",
          compatibilityDate: "2026-07-24",
          durableObjects: {
            UPSTREAM_CONNECTION: {
              className: "UpstreamConnection",
              useSQLite: true,
            },
          },
          modules: true,
          script: `
            function json(value, status = 200) {
              return new Response(JSON.stringify(value), {
                status,
                headers: { "content-type": "application/json" },
              });
            }

            export class UpstreamConnection {
              constructor(state) {
                this.state = state;
                this.server = undefined;
                this.messages = [];
                this.closes = [];
              }

              async fetch(request) {
                const url = new URL(request.url);
                const id = url.searchParams.get("connection_id");
                if (
                  url.pathname === "/responses" &&
                  request.headers.get("upgrade")?.toLowerCase() === "websocket" &&
                  id
                ) {
                  if (this.server) {
                    return json({ error: "connection already exists" }, 409);
                  }
                  const handshakeDelayMs = Number(
                    url.searchParams.get("handshake_delay_ms") ?? "0",
                  );
                  if (Number.isFinite(handshakeDelayMs) && handshakeDelayMs > 0) {
                    await new Promise((resolve) => setTimeout(resolve, handshakeDelayMs));
                  }
                  const pair = new WebSocketPair();
                  const server = pair[1];
                  server.binaryType = "arraybuffer";
                  server.addEventListener("message", (event) => {
                    if (typeof event.data === "string") {
                      this.messages.push({ kind: "text", data: event.data });
                    } else if (event.data instanceof ArrayBuffer) {
                      this.messages.push({
                        kind: "binary",
                        data: [...new Uint8Array(event.data)],
                      });
                    }
                  });
                  server.addEventListener("close", (event) => {
                    this.closes.push({
                      code: event.code,
                      reason: event.reason,
                      wasClean: event.wasClean,
                    });
                  });
                  server.accept({ allowHalfOpen: true });
                  this.server = server;
                  return new Response(null, { status: 101, webSocket: pair[0] });
                }

                if (!id || !this.server) {
                  return json({ error: "connection not found" }, 404);
                }
                if (url.pathname === "/__test/messages" && request.method === "GET") {
                  return json({ messages: this.messages.splice(0) });
                }
                if (url.pathname === "/__test/closes" && request.method === "GET") {
                  return json({ closes: this.closes.splice(0) });
                }
                if (url.pathname === "/__test/send" && request.method === "POST") {
                  if (request.headers.get("x-test-binary") === "1") {
                    this.server.send(await request.arrayBuffer());
                  } else {
                    this.server.send(await request.text());
                  }
                  return new Response(null, { status: 204 });
                }
                if (
                  url.pathname === "/__test/send-and-close" &&
                  request.method === "POST"
                ) {
                  const code = Number(url.searchParams.get("code") ?? "1011");
                  const reason = url.searchParams.get("reason") ?? "";
                  this.server.send(await request.text());
                  this.server.close(code, reason);
                  return new Response(null, { status: 204 });
                }
                if (url.pathname === "/__test/close" && request.method === "POST") {
                  const code = Number(url.searchParams.get("code") ?? "1000");
                  const reason = url.searchParams.get("reason") ?? "";
                  this.server.close(code, reason);
                  return new Response(null, { status: 204 });
                }
                return json({ error: "not found" }, 404);
              }
            }

            export default {
              fetch(request, env) {
                const id = new URL(request.url).searchParams.get("connection_id");
                if (!id) {
                  return json({ error: "connection_id is required" }, 400);
                }
                return env.UPSTREAM_CONNECTION.getByName(id).fetch(request);
              },
            };
          `,
        }],
      },
    }),
  ],
  test: {
    include: ["tests/worker/**/*.test.ts"],
  },
});
