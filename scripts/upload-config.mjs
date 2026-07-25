import { spawn } from "node:child_process";

import { readValidatedConfig } from "./config-utils.mjs";

const args = process.argv.slice(2);
const local = args.includes("--local");
const path = args.find((arg) => !arg.startsWith("--")) ?? "config.json";

try {
  await readValidatedConfig(path);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const wranglerArgs = [
  "kv",
  "key",
  "put",
  "gateway-config",
  "--binding",
  "CONFIG_KV",
  "--path",
  path,
  local ? "--local" : "--remote",
];
const command = process.platform === "win32" ? "wrangler.cmd" : "wrangler";
const child = spawn(command, wranglerArgs, { stdio: "inherit" });

child.on("error", (error) => {
  console.error(`could not start Wrangler: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
