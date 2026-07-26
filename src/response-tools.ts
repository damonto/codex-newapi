import type {
  ClientApiKeyConfig,
  GatewayConfig,
} from "./types.ts";

export const IMAGE_GENERATION_MODEL = "gpt-image-2";

const IMAGE_GENERATION_NAMESPACE = "image_gen";
const IMAGE_GENERATION_TOOL = {
  type: "image_generation",
  output_format: "png",
} as const;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isImageGenerationTool(value: unknown): boolean {
  if (!isObject(value)) {
    return false;
  }
  return value.type === IMAGE_GENERATION_TOOL.type ||
    (value.type === "namespace" && value.name === IMAGE_GENERATION_NAMESPACE);
}

function injectIntoTools(owner: JsonObject): boolean {
  const tools = owner.tools;
  if (tools === undefined || tools === null) {
    owner.tools = [{ ...IMAGE_GENERATION_TOOL }];
    return true;
  }
  if (!Array.isArray(tools) || tools.some(isImageGenerationTool)) {
    return false;
  }
  tools.push({ ...IMAGE_GENERATION_TOOL });
  return true;
}

export function clientCanUseImageGeneration(
  config: GatewayConfig,
  client: ClientApiKeyConfig,
): boolean {
  const allowedServiceIds = new Set(client.services);
  return config.services.some(
    (service) =>
      !service.disabled &&
      allowedServiceIds.has(service.id) &&
      service.models.includes(IMAGE_GENERATION_MODEL),
  );
}

export function injectImageGenerationTool(
  payload: JsonObject,
  responsesLite: boolean,
): boolean {
  if (responsesLite) {
    // Responses Lite reserves additional_tools for client-executed schemas.
    return false;
  }
  return injectIntoTools(payload);
}
