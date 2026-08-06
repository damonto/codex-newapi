export type RandomSource = () => number;

export function secureRandomUnit(): number {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0] / 0x1_0000_0000;
}

export function randomEntry<T>(
  entries: readonly T[],
  random: RandomSource,
): T | undefined {
  if (entries.length === 0) {
    return undefined;
  }
  const value = random();
  const normalized = Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0;
  const index = Math.min(entries.length - 1, Math.floor(normalized * entries.length));
  return entries[index];
}
