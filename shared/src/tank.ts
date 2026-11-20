/**
 * Pot physics, shared by the real-time MOVE phase (server authority + client
 * prediction) and by RESOLVE (no input, just momentum). One call = one 60 Hz
 * tick. Positions are FP integers; (x, y) is the centre of the pot's feet.
 */
import { MATERIALS } from "./content/materials";
import { POT } from "./content/tanks";
import { CellBox, digCircle, Grid } from "./grid";

export const IN_LEFT = 1;
export const IN_RIGHT = 2;
export const IN_JUMP = 4;
export const IN_DIG = 8;
export const IN_UP = 16;
export const IN_DOWN = 32;
export const IN_MASK = 63;

export interface Tank {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  hp: number;
  alive: boolean;
  grounded: boolean;
  facing: number;
  /** Ticks of reflective dome left (RESOLVE only). */
  shield: number;
  /** Set by a Steam Jump: the next landing is free. */
  cushion: boolean;
  /** Horizontal distance still owed before the next step-up (slope limit). */
  debt: number;
  /** Who last knocked this pot about, for crediting fall damage. */
  lastHit: number;
  dig: number;
}

export function makeTank(id: number, x: number, y: number): Tank {
  return {
    id,
    x,
    y,
    vx: 0,
    vy: 0,
    hp: POT.hp,
    alive: true,
    grounded: false,
    facing: x < 0 ? 1 : 1,
    shield: 0,
    cushion: false,
    debt: 0,
    lastHit: -1,
    dig: POT.digEnergy,
  };
}

export function cloneTank(t: Tank): Tank {
  return { ...t };
}

/** Wire format: everything RESOLVE needs to start from identical state. */
export type TankWire = [number, number, number, number, number, number, number, number];
export function packTank(t: Tank): TankWire {
  return [t.id, t.x, t.y, t.hp, t.alive ? 1 : 0, t.grounded ? 1 : 0, t.facing, t.dig];
}
export function unpackTank(a: TankWire): Tank {
  const t = makeTank(a[0], a[1], a[2]);
  t.hp = a[3];
  t.alive = !!a[4];
  t.grounded = !!a[5];
  t.facing = a[6];
  t.dig = a[7];
  return t;
}

export function tankCells(x: number, y: number): CellBox {
  return {
    x0: Math.floor((x - POT.hw) / 256),
    x1: Math.floor((x + POT.hw - 1) / 256),
    y0: Math.floor((y - POT.ht) / 256),
    y1: Math.floor((y - 1) / 256),
  };
}

export function boxFree(g: Grid, x: number, y: number): boolean {
  const x0 = Math.floor((x - POT.hw) / 256);
  const x1 = Math.floor((x + POT.hw - 1) / 256);
  const y0 = Math.floor((y - POT.ht) / 256);
  const y1 = Math.floor((y - 1) / 256);
  for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) if (g.solid(cx, cy)) return false;
  return true;
}

/** Is the pot standing on something bouncy? */
function onBouncy(g: Grid, x: number, y: number): boolean {
  const x0 = Math.floor((x - POT.hw) / 256);
  const x1 = Math.floor((x + POT.hw - 1) / 256);
  const row = Math.floor(y / 256);
  let bouncy = 0;
  let other = 0;
  for (let cx = x0; cx <= x1; cx++) {
    const m = g.get(cx, row);
    if (m === 0) continue;
    if (MATERIALS[m].bouncy) bouncy++;
    else other++;
  }
  return bouncy > other;
}

export type TankEmit = (kind: "land" | "bonk" | "boing", t: Tank, speed: number) => void;

/**
 * Advance one tick. `input` is a bitmask of IN_*; pass 0 with resolve=true
 * during RESOLVE, where pots only coast, bounce and fall.
 */
export function stepTank(g: Grid, t: Tank, input: number, resolve: boolean, emit?: TankEmit): void {
  if (!t.alive) return;
  if (!resolve) {
    const dir = (input & IN_RIGHT ? 1 : 0) - (input & IN_LEFT ? 1 : 0);
    t.vx = dir * (input & IN_DIG ? POT.walk >> 1 : POT.walk);
    if (dir) t.facing = dir;
    if (input & IN_JUMP && t.grounded) {
      t.vy = -POT.jump;
      t.grounded = false;
    }
  }
  const wasGrounded = t.grounded;
  t.vy = Math.min(POT.maxFall, t.vy + POT.gravity);

  // ---- horizontal sweep, in steps no longer than half a cell ----
  let rem = t.vx;
  while (rem !== 0) {
    const s = rem > 128 ? 128 : rem < -128 ? -128 : rem;
    rem -= s;
    if (boxFree(g, t.x + s, t.y)) {
      t.x += s;
      t.debt = Math.max(0, t.debt - Math.abs(s));
      continue;
    }
    // Slope limit: a pot may step up one or two cells, but each cell climbed
    // must be paid for with a cell of forward travel (so 45 degrees is the
    // steepest climbable slope, and a sheer face is a wall).
    let climbed = false;
    if (!resolve && wasGrounded && t.debt <= 0) {
      const footY = Math.floor(t.y / 256) * 256;
      for (let up = 1; up <= 2 && !climbed; up++) {
        const ny = footY - up * 256;
        if (boxFree(g, t.x + s, ny) && boxFree(g, t.x, ny)) {
          t.x += s;
          t.y = ny;
          t.debt = up * 256 - Math.abs(s);
          climbed = true;
        }
      }
    }
    if (!climbed) {
      if (resolve) {
        if (Math.abs(t.vx) > 120 && emit) emit("bonk", t, Math.abs(t.vx));
        t.vx = -Math.trunc(t.vx / 3);
      } else t.vx = 0;
      rem = 0;
    }
  }

  // ---- walking down a slope: stay glued to the ground rather than hopping ----
  if (!resolve && wasGrounded && t.vy >= 0 && t.vy <= POT.gravity && boxFree(g, t.x, t.y + 256)) {
    if (!boxFree(g, t.x, t.y + 512)) t.y += 256;
    else if (!boxFree(g, t.x, t.y + 768)) t.y += 512;
  }

  // ---- vertical sweep ----
  rem = t.vy;
  t.grounded = false;
  while (rem !== 0) {
    const s = rem > 128 ? 128 : rem < -128 ? -128 : rem;
    rem -= s;
    if (boxFree(g, t.x, t.y + s)) {
      t.y += s;
      continue;
    }
    if (s > 0) {
      // Snap the feet to the top of the row we hit.
      t.y = Math.floor((t.y + s - 1) / 256) * 256;
      const impact = t.vy;
      if (impact > 110 && onBouncy(g, t.x, t.y)) {
        t.vy = -Math.trunc((impact * 4) / 5) - (input & IN_JUMP ? 60 : 0);
        if (emit) emit("boing", t, impact);
      } else {
        t.vy = 0;
        t.grounded = true;
        if (emit && !wasGrounded && impact > 60) emit("land", t, t.cushion ? 0 : impact);
        t.cushion = false;
      }
    } else {
      t.vy = 0;
    }
    rem = 0;
  }

  if (resolve && t.grounded) {
    t.vx = Math.trunc((t.vx * 3) / 4);
    if (Math.abs(t.vx) < 8) t.vx = 0;
  }
}

/** True when a pot has come to rest (used to decide RESOLVE is over). */
export function atRest(t: Tank): boolean {
  return !t.alive || (t.grounded && t.vx === 0);
}

/**
 * The MOVE-phase spoon. Bites a circle out of the terrain ahead of the pot in
 * the held direction. Returns the edit that was applied, or null.
 */
export interface DigEdit {
  x: number;
  y: number;
  r: number;
  /** Energy budget the bite was allowed (needed to replay partial bites). */
  b: number;
}

export function digTarget(t: Tank, input: number): { x: number; y: number } {
  let dx = (input & IN_RIGHT ? 1 : 0) - (input & IN_LEFT ? 1 : 0);
  const dy = (input & IN_DOWN ? 1 : 0) - (input & IN_UP ? 1 : 0);
  if (dx === 0 && dy === 0) dx = t.facing;
  return { x: t.x + dx * POT.digReach, y: t.y - (POT.ht >> 1) + dy * POT.digReach };
}

export function tankDig(g: Grid, t: Tank, input: number): DigEdit | null {
  if (!t.alive || !(input & IN_DIG) || t.dig <= 0) return null;
  const p = digTarget(t, input);
  const b = t.dig;
  const spent = digCircle(g, p.x, p.y, POT.digRadius, b);
  if (spent === 0) return null;
  t.dig -= spent;
  return { x: p.x, y: p.y, r: POT.digRadius, b };
}

export function applyDigEdit(g: Grid, e: DigEdit): number {
  return digCircle(g, e.x, e.y, e.r, e.b);
}

/**
 * Fairness guarantee: a pot must never be embedded in terrain. If it somehow
 * is (it should not be — blobs and falling chunks avoid pot boxes), lift it
 * to the nearest free spot above.
 */
export function ensureFree(g: Grid, t: Tank): void {
  if (!t.alive || boxFree(g, t.x, t.y)) return;
  for (let up = 1; up < g.h; up++) {
    if (boxFree(g, t.x, t.y - up * 256)) {
      t.y -= up * 256;
      return;
    }
  }
}
