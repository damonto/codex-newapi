import { randomEntry, type RandomSource } from "./random.ts";

export const SESSION_AFFINITY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_AFFINITY_INDEX_MAX_PAGE_SIZE = 1000;

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
  binding_id: string;
  created_at: number;
  generation: number;
  registry_name: string;
  session_digest: string;
  session_id: string;
  index_registered: boolean;
}

export interface SessionAffinityResolution extends SessionAffinityRecord {
  status: "hit" | "created" | "rebound";
}

export interface AffinitySelection {
  service_id: string;
  key_id: string;
}

export interface SessionAffinityRegistration {
  registry_name: string;
  session_digest: string;
  session_id: string;
}

export interface SessionAffinityIdentity extends SessionAffinityRegistration {
  object_name: string;
}

export interface StoredAffinityDecision {
  // Always present, possibly undefined: every caller computes a candidate that
  // may not exist rather than omitting the field.
  selection: AffinitySelection | undefined;
  status: "hit" | "rebound";
}

export type AffinityRandomSource = RandomSource;

export function chooseAffinityCandidate(
  candidates: AffinityServiceCandidate[],
  random?: AffinityRandomSource,
): AffinitySelection | undefined {
  const usableServices = candidates.filter(
    (candidate) => candidate.keys.length > 0,
  );
  if (usableServices.length === 0) {
    return undefined;
  }
  const servicePriority = Math.max(
    ...usableServices.map((candidate) => candidate.priority),
  );
  const tiedServices = usableServices.filter(
    (candidate) => candidate.priority === servicePriority,
  );
  const service =
    random === undefined ? tiedServices[0] : randomEntry(tiedServices, random);
  if (!service) {
    return undefined;
  }
  const keyPriority = Math.max(...service.keys.map((key) => key.priority));
  const tiedKeys = service.keys.filter(
    (candidate) => candidate.priority === keyPriority,
  );
  const key =
    random === undefined ? tiedKeys[0] : randomEntry(tiedKeys, random);
  return key
    ? { service_id: service.service_id, key_id: key.key_id }
    : undefined;
}

export function affinitySelectionIsHighestPriority(
  selection: AffinitySelection | undefined,
  candidates: AffinityServiceCandidate[],
): selection is AffinitySelection {
  if (!selection) {
    return false;
  }
  const service = candidates.find(
    (candidate) =>
      candidate.service_id === selection.service_id &&
      candidate.keys.length > 0,
  );
  if (!service) {
    return false;
  }
  const highestServicePriority = Math.max(
    ...candidates
      .filter((candidate) => candidate.keys.length > 0)
      .map((candidate) => candidate.priority),
  );
  if (service.priority !== highestServicePriority) {
    return false;
  }
  const key = service.keys.find(
    (candidate) => candidate.key_id === selection.key_id,
  );
  if (!key) {
    return false;
  }
  const highestKeyPriority = Math.max(
    ...service.keys.map((candidate) => candidate.priority),
  );
  return key.priority === highestKeyPriority;
}

function choosePreferredOrRandom(
  candidates: AffinityServiceCandidate[],
  preferred: AffinitySelection | undefined,
  random: AffinityRandomSource | undefined,
): AffinitySelection | undefined {
  return affinitySelectionIsHighestPriority(preferred, candidates)
    ? preferred
    : chooseAffinityCandidate(candidates, random);
}

function choosePreferredOrRandomWithinService(
  service: AffinityServiceCandidate,
  preferred: AffinitySelection | undefined,
  random: AffinityRandomSource | undefined,
): AffinitySelection | undefined {
  const highestKeyPriority = Math.max(
    ...service.keys.map((candidate) => candidate.priority),
  );
  const preferredKey =
    preferred?.service_id === service.service_id
      ? service.keys.find((candidate) => candidate.key_id === preferred.key_id)
      : undefined;
  return preferredKey?.priority === highestKeyPriority
    ? preferred
    : chooseAffinityCandidate([service], random);
}

export function resolveStoredAffinity(
  record: SessionAffinityRecord,
  candidates: AffinityServiceCandidate[],
  preferred?: AffinitySelection,
  random?: AffinityRandomSource,
): StoredAffinityDecision {
  const fallback = (): AffinitySelection | undefined =>
    choosePreferredOrRandom(candidates, preferred, random);
  const service = candidates.find(
    (candidate) => candidate.service_id === record.service_id,
  );
  const key = service?.keys.find(
    (candidate) => candidate.key_id === record.key_id,
  );
  if (!service || !key) {
    return { selection: fallback(), status: "rebound" };
  }

  const usableServices = candidates.filter(
    (candidate) => candidate.keys.length > 0,
  );
  const highestServicePriority = Math.max(
    ...usableServices.map((candidate) => candidate.priority),
  );
  if (service.priority < highestServicePriority) {
    return { selection: fallback(), status: "rebound" };
  }

  const highestKeyPriority = Math.max(
    ...service.keys.map((candidate) => candidate.priority),
  );
  if (key.priority < highestKeyPriority) {
    return {
      selection: choosePreferredOrRandomWithinService(
        service,
        preferred,
        random,
      ),
      status: "rebound",
    };
  }

  return {
    selection: { service_id: record.service_id, key_id: record.key_id },
    status: "hit",
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function affinityObjectNameFromDigests(
  registryName: string,
  sessionDigest: string,
): string {
  return `${registryName}:${sessionDigest}`;
}

export function affinityRegistryName(clientApiKey: string): Promise<string> {
  return sha256Hex(clientApiKey);
}

export function affinitySessionDigest(sessionId: string): Promise<string> {
  return sha256Hex(sessionId);
}

export async function sessionAffinityIdentity(
  clientApiKey: string,
  sessionId: string,
): Promise<SessionAffinityIdentity> {
  const [registryName, sessionDigest] = await Promise.all([
    affinityRegistryName(clientApiKey),
    affinitySessionDigest(sessionId),
  ]);
  return {
    registry_name: registryName,
    session_digest: sessionDigest,
    session_id: sessionId,
    object_name: affinityObjectNameFromDigests(registryName, sessionDigest),
  };
}

export async function affinityObjectName(
  clientApiKey: string,
  sessionId: string,
): Promise<string> {
  return (await sessionAffinityIdentity(clientApiKey, sessionId)).object_name;
}
