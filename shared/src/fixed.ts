/**
 * Fixed-point helpers. The simulation stores positions/velocities as
 * integer-valued numbers in units of 1/256 cell ("FP"). Only + - * / and
 * Math.sqrt/trunc/floor are used on them: all are exactly specified by
 * IEEE-754, so results are bit-identical on every JS engine. The only
 * transcendental function (sin) is baked into an integer table at load.
 */
export const FP = 256;

/** Angles are integers in tenths of a degree: 0 = right, 900 = straight up. */
export const ANGLE_STEPS = 3600;
const SIN = new Int32Array(ANGLE_STEPS);
for (let i = 0; i < ANGLE_STEPS; i++) {
  // Rounded to 16 bits: engines whose Math.sin differ by an ulp still agree.
  SIN[i] = Math.round(Math.sin((i * Math.PI * 2) / ANGLE_STEPS) * 65536);
}
export function isin(a: number): number {
  return SIN[((a % ANGLE_STEPS) + ANGLE_STEPS) % ANGLE_STEPS];
}
export function icos(a: number): number {
  return isin(a + 900);
}

export function clampInt(v: unknown, lo: number, hi: number, dflt = lo): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : dflt;
  return n < lo ? lo : n > hi ? hi : n;
}

export function isqrt(n: number): number {
  return Math.floor(Math.sqrt(n));
}

/** Velocity (FP/tick) for a launch at `angle` with `power` 0..1000 of maxSpeed. */
export function launchVel(angle: number, power: number, maxSpeed: number): [number, number] {
  const sp = Math.trunc((maxSpeed * power) / 1000);
  return [Math.trunc((icos(angle) * sp) / 65536), -Math.trunc((isin(angle) * sp) / 65536)];
}
