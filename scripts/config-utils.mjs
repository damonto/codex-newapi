import { readFile } from "node:fs/promises";

import { parseConfig } from "../src/config.ts";

export async function readValidatedConfig(path) {
  const raw = await readFile(path, "utf8");
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error.message}`);
  }
  return { raw, config: parseConfig(value) };
}
