import { readValidatedConfig } from "./config-utils.mjs";

const path = process.argv[2] ?? "config.json";

try {
  const { config } = await readValidatedConfig(path);
  console.log(
    `${path}: valid (${config.services.length} services, ${config.api_keys.length} client API keys)`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
