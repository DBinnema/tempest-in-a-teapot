/** The pot: body dimensions and movement stats (FP units, 60 Hz ticks). */
export const POT = {
  /** Half width / full height of the collision box. */
  hw: 560,
  ht: 1000,
  hp: 100,
  walk: 64,
  jump: 172,
  gravity: 10,
  maxFall: 700,
  /** Landing faster than this (FP/tick) hurts during RESOLVE. */
  fallSafe: 300,
  /** Dig energy per round, the radius of the spoon bite and its reach (FP). */
  digEnergy: 260,
  digRadius: 850,
  digReach: 620,
};
