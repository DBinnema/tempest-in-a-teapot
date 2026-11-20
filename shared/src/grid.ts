/**
 * The world: a true 2D cell grid (one material id per cell), so caves,
 * overhangs and floating islands are just... cells. All edits are integer
 * operations, so the same seed + the same edits give the same bytes on the
 * server and on every client.
 */
import { AIR, MATERIALS, PLATE } from "./content/materials";
import { fnv1a } from "./prng";

export const WORLD_W = 360;
export const WORLD_H = 200;

const SOLID = MATERIALS.map((m) => m.id !== AIR);
const TOUGH = MATERIALS.map((m) => m.tough);
const ANCHOR = MATERIALS.map((m) => m.anchor);
const DIGCOST = MATERIALS.map((m) => m.digCost);

/** Axis-aligned cell box, used to keep terrain from materialising inside pots. */
export interface CellBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export class Grid {
  readonly cells: Uint8Array;
  /** Set when terrain changed in a way that may have left chunks unsupported. */
  loose = false;
  /** Bounding box of cells changed since the renderer last looked (client only reads it). */
  dx0 = 1e9;
  dy0 = 1e9;
  dx1 = -1;
  dy1 = -1;

  constructor(
    readonly w: number = WORLD_W,
    readonly h: number = WORLD_H,
    cells?: Uint8Array,
  ) {
    this.cells = cells ?? new Uint8Array(w * h);
  }

  clone(): Grid {
    const g = new Grid(this.w, this.h, this.cells.slice());
    g.loose = this.loose;
    return g;
  }

  /** Out of bounds: the sides and floor are solid plate, the sky is open. */
  get(x: number, y: number): number {
    if (y < 0) return x < 0 || x >= this.w ? PLATE : AIR;
    if (x < 0 || x >= this.w || y >= this.h) return PLATE;
    return this.cells[y * this.w + x];
  }

  solid(x: number, y: number): boolean {
    return this.get(x, y) !== AIR;
  }

  set(x: number, y: number, m: number): void {
    if (x < 0 || x >= this.w || y < 0 || y >= this.h) return;
    this.cells[y * this.w + x] = m;
    this.touch(x, y);
  }

  touch(x: number, y: number): void {
    if (x < this.dx0) this.dx0 = x;
    if (x > this.dx1) this.dx1 = x;
    if (y < this.dy0) this.dy0 = y;
    if (y > this.dy1) this.dy1 = y;
  }

  touchAll(): void {
    this.dx0 = 0;
    this.dy0 = 0;
    this.dx1 = this.w - 1;
    this.dy1 = this.h - 1;
  }

  clearDirty(): void {
    this.dx0 = 1e9;
    this.dy0 = 1e9;
    this.dx1 = -1;
    this.dy1 = -1;
  }

  hash(): number {
    return fnv1a(this.cells);
  }

  /** Run-length encoding, for late joiners / resync only (never per tick). */
  toRLE(): number[] {
    const out: number[] = [];
    const c = this.cells;
    let run = 1;
    for (let i = 1; i <= c.length; i++) {
      if (i < c.length && c[i] === c[i - 1] && run < 65535) run++;
      else {
        out.push(run, c[i - 1]);
        run = 1;
      }
    }
    return out;
  }

  loadRLE(rle: number[]): void {
    let i = 0;
    for (let k = 0; k + 1 < rle.length && i < this.cells.length; k += 2) {
      const n = rle[k] | 0;
      const m = rle[k + 1] | 0;
      this.cells.fill(m < MATERIALS.length ? m : 0, i, Math.min(this.cells.length, i + n));
      i += n;
    }
    this.loose = true;
    this.touchAll();
  }
}

/**
 * Remove destructible cells inside a circle (centre/radius in FP). Tougher
 * materials shrink the effective radius. Returns the number of cells removed.
 */
export function carveCircle(g: Grid, cx: number, cy: number, r: number): number {
  const x0 = Math.max(0, Math.floor((cx - r) / 256));
  const x1 = Math.min(g.w - 1, Math.floor((cx + r) / 256));
  const y0 = Math.max(0, Math.floor((cy - r) / 256));
  const y1 = Math.min(g.h - 1, Math.floor((cy + r) / 256));
  const r2 = r * r * 100;
  let n = 0;
  for (let y = y0; y <= y1; y++) {
    const dy = y * 256 + 128 - cy;
    for (let x = x0; x <= x1; x++) {
      const i = y * g.w + x;
      const m = g.cells[i];
      if (m === AIR) continue;
      const t = TOUGH[m];
      if (t === 0) continue;
      const dx = x * 256 + 128 - cx;
      if ((dx * dx + dy * dy) * t * t <= r2) {
        g.cells[i] = AIR;
        g.touch(x, y);
        n++;
      }
    }
  }
  if (n) g.loose = true;
  return n;
}

/**
 * A pot's spoon: removes every diggable cell in the circle regardless of
 * toughness, but pays per cell. Stops when the budget runs out (scan order is
 * fixed, so a partial bite is still deterministic). Returns energy spent.
 */
export function digCircle(g: Grid, cx: number, cy: number, r: number, budget: number): number {
  const x0 = Math.max(0, Math.floor((cx - r) / 256));
  const x1 = Math.min(g.w - 1, Math.floor((cx + r) / 256));
  const y0 = Math.max(0, Math.floor((cy - r) / 256));
  const y1 = Math.min(g.h - 1, Math.floor((cy + r) / 256));
  const r2 = r * r;
  let spent = 0;
  for (let y = y0; y <= y1; y++) {
    const dy = y * 256 + 128 - cy;
    for (let x = x0; x <= x1; x++) {
      const i = y * g.w + x;
      const cost = DIGCOST[g.cells[i]];
      if (cost === 0) continue;
      const dx = x * 256 + 128 - cx;
      if (dx * dx + dy * dy > r2) continue;
      if (spent + cost > budget) return spent;
      g.cells[i] = AIR;
      g.touch(x, y);
      spent += cost;
    }
  }
  if (spent) g.loose = true;
  return spent;
}

/** Fill empty cells in a circle with `mat`, never inside the given boxes. */
export function addBlob(g: Grid, cx: number, cy: number, r: number, mat: number, keepOut: CellBox[]): number {
  const x0 = Math.max(0, Math.floor((cx - r) / 256));
  const x1 = Math.min(g.w - 1, Math.floor((cx + r) / 256));
  const y0 = Math.max(0, Math.floor((cy - r) / 256));
  const y1 = Math.min(g.h - 1, Math.floor((cy + r) / 256));
  const r2 = r * r;
  let n = 0;
  for (let y = y0; y <= y1; y++) {
    const dy = y * 256 + 128 - cy;
    for (let x = x0; x <= x1; x++) {
      const i = y * g.w + x;
      if (g.cells[i] !== AIR) continue;
      const dx = x * 256 + 128 - cx;
      if (dx * dx + dy * dy > r2) continue;
      let blocked = false;
      for (const b of keepOut) {
        if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      g.cells[i] = mat;
      g.touch(x, y);
      n++;
    }
  }
  if (n) g.loose = true;
  return n;
}

/**
 * Find connected groups of solid cells that are not attached (4-neighbour) to
 * any anchor material. `skip` marks cells already owned by a falling chunk;
 * they are treated as air. Returns each group as ascending cell indices.
 */
export function findLoose(g: Grid, skip?: Int16Array): Int32Array[] {
  const { w, h, cells } = g;
  const n = w * h;
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  let sp = 0;
  for (let i = 0; i < n; i++) {
    if (ANCHOR[cells[i]]) {
      seen[i] = 1;
      stack[sp++] = i;
    }
  }
  const flood = (collect: number[] | null) => {
    while (sp > 0) {
      const i = stack[--sp];
      if (collect) collect.push(i);
      const x = i % w;
      if (x > 0) visit(i - 1);
      if (x < w - 1) visit(i + 1);
      if (i >= w) visit(i - w);
      if (i < n - w) visit(i + w);
    }
  };
  const visit = (j: number) => {
    if (seen[j] || !SOLID[cells[j]] || (skip && skip[j])) return;
    seen[j] = 1;
    stack[sp++] = j;
  };
  flood(null);
  const out: Int32Array[] = [];
  for (let i = 0; i < n; i++) {
    if (seen[i] || !SOLID[cells[i]] || (skip && skip[i])) continue;
    seen[i] = 1;
    stack[sp++] = i;
    const group: number[] = [];
    flood(group);
    group.sort((a, b) => a - b);
    out.push(Int32Array.from(group));
  }
  return out;
}
