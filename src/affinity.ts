import {
  randomEntry,
  secureRandomUnit,
  type RandomSource,
} from "./random.ts";

export const SESSION_AFFINITY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface AffinityKeyCandidate {
  key_id: string;
  priority: number;
}

export interface AffinityServiceCandidate {
  service_id: string;
  priority: number;
  keys: AffinityKeyCandidate[];
}

export interface SessionAffinityRecord {
  service_id: string;
  key_id: string;
  updated_at: number;
}

export interface SessionAffinityResolution extends SessionAffinityRecord {
  status: "hit" | "created" | "rebound";
}

export interface AffinitySelection {
  service_id: string;
  key_id: string;
}

export type AffinityRandomSource = RandomSource;

export function chooseAffinityCandidate(
  candidates: AffinityServiceCandidate[],
  random: AffinityRandomSource = secureRandomUnit,
): AffinitySelection | undefined {
  const usableServices = candidates.filter((candidate) => candidate.keys.length > 0);
  if (usableServices.length === 0) {
    return undefined;
  }
  const servicePriority = Math.max(...usableServices.map((candidate) => candidate.priority));
  const service = randomEntry(
    usableServices.filter((candidate) => candidate.priority === servicePriority),
    random,
  );
  if (!service) {
    return undefined;
  }
  const keyPriority = Math.max(...service.keys.map((key) => key.priority));
  const key = randomEntry(
    service.keys.filter((candidate) => candidate.priority === keyPriority),
    random,
  );
  return key ? { service_id: service.service_id, key_id: key.key_id } : undefined;
}

export async function affinityObjectName(
  clientApiKey: string,
  sessionId: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const [clientDigest, sessionDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(clientApiKey)),
    crypto.subtle.digest("SHA-256", encoder.encode(sessionId)),
  ]);
  const hex = (digest: ArrayBuffer): string => [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex(clientDigest)}:${hex(sessionDigest)}`;
}
