/** Integer-safe deterministic PRNG + hashing. Never use Math.random in shared/. */

export function hash32(n: number): number {
  n = Math.imul(n ^ (n >>> 16), 0x85ebca6b);
  n = Math.imul(n ^ (n >>> 13), 0xc2b2ae35);
  return (n ^ (n >>> 16)) >>> 0;
}

export function hash2(seed: number, a: number, b: number): number {
  return hash32(seed ^ Math.imul(a, 374761393) ^ Math.imul(b, 668265263));
}

export interface Rng {
  /** uint32 */
  next(): number;
  /** integer in [lo, hi] inclusive */
  int(lo: number, hi: number): number;
  /** true with probability num/den */
  chance(num: number, den: number): boolean;
}

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
  return {
    next,
    int: (lo, hi) => lo + (next() % (hi - lo + 1)),
    chance: (num, den) => next() % den < num,
  };
}

/** FNV-1a over bytes, used for terrain/world hashes. */
export function fnv1a(bytes: Uint8Array, h = 0x811c9dc5): number {
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
