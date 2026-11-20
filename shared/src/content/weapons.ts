/**
 * Everything a pot can queue in a lump. Mechanics only; display names, blurbs
 * and sounds live in theme.ts keyed by `id` (with fallbacks, so a new entry
 * here works on its own).
 *
 * `kind` selects the behaviour implemented in sim.ts:
 *  shell   – explodes on first contact
 *  bouncer – ricochets, explodes when its fuse runs out (or on a pot)
 *  cluster – splits into bomblets at the top of its arc
 *  drill   – bores a walkable tunnel through terrain, explodes at the end
 *  builder – adds a blob of terrain where it lands
 *  jump    – launches the pot itself
 *  shield  – a reflective dome over the pot for a while
 */
export type WeaponKind = "shell" | "bouncer" | "cluster" | "drill" | "builder" | "jump" | "shield";

export interface WeaponDef {
  id: string;
  kind: WeaponKind;
  /** Uses per match; -1 = unlimited. */
  ammo: number;
  /** Launch speed at full power, FP/tick. */
  speed: number;
  /** Blast (or blob / dome) radius in FP. */
  radius: number;
  damage: number;
  /** Ticks until a timed detonation (bouncer) or dome expiry (shield). */
  fuse?: number;
  /** Percent of speed kept on a bounce. */
  bounce?: number;
  bomblets?: number;
  /** Drill: how many ticks it can bore, and the tunnel radius in FP. */
  drillTicks?: number;
  tunnel?: number;
  /** Not selectable (spawned by other weapons). */
  hidden?: boolean;
}

const C = 256; // one cell in FP

export const WEAPONS: WeaponDef[] = [
  { id: "sugar", kind: "shell", ammo: -1, speed: 640, radius: 9 * C, damage: 34 },
  { id: "jawbreaker", kind: "bouncer", ammo: 3, speed: 600, radius: 11 * C, damage: 46, fuse: 170, bounce: 55 },
  { id: "sprinkles", kind: "cluster", ammo: 2, speed: 640, radius: 7 * C, damage: 22, bomblets: 6 },
  { id: "corkscrew", kind: "drill", ammo: 3, speed: 640, radius: 7 * C, damage: 30, drillTicks: 84, tunnel: 716 },
  { id: "dough", kind: "builder", ammo: 3, speed: 600, radius: 8 * C, damage: 0 },
  { id: "steam", kind: "jump", ammo: -1, speed: 380, radius: 0, damage: 0 },
  { id: "cloche", kind: "shield", ammo: 2, speed: 0, radius: 1700, damage: 0, fuse: 210 },
  { id: "bomblet", kind: "shell", ammo: 0, speed: 0, radius: 5 * C, damage: 13, hidden: true },
  // The blast a pot makes when it shatters. Chain reactions welcome.
  { id: "shatter", kind: "shell", ammo: 0, speed: 0, radius: 6 * C, damage: 16, hidden: true },
];

export const WEAPON_BY_ID: Record<string, WeaponDef> = Object.fromEntries(WEAPONS.map((w) => [w.id, w]));
export const SELECTABLE = WEAPONS.filter((w) => !w.hidden);
