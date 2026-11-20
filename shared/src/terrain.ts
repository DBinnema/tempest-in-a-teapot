/**
 * Seeded terrain generation: a layered cake with real caves, overhangs,
 * candy-pillar tables and floating islands. Integer maths only.
 */
import { AIR, CANDY, CREAM, FUDGE, ICING, JELLY, PLATE, SPONGE } from "./content/materials";
import { POT } from "./content/tanks";
import { findLoose, Grid, WORLD_H, WORLD_W } from "./grid";
import { hash2, mulberry32, Rng } from "./prng";
import { boxFree } from "./tank";

/** Smooth integer value noise, 0..1023. */
export function noise2(seed: number, x: number, y: number, scale: number): number {
  const ix = Math.floor(x / scale);
  const iy = Math.floor(y / scale);
  let fx = Math.floor(((x - ix * scale) * 256) / scale);
  let fy = Math.floor(((y - iy * scale) * 256) / scale);
  fx = (fx * fx * (768 - 2 * fx)) >> 16;
  fy = (fy * fy * (768 - 2 * fy)) >> 16;
  const a = hash2(seed, ix, iy) & 1023;
  const b = hash2(seed, ix + 1, iy) & 1023;
  const c = hash2(seed, ix, iy + 1) & 1023;
  const d = hash2(seed, ix + 1, iy + 1) & 1023;
  const top = a * (256 - fx) + b * fx;
  const bot = c * (256 - fx) + d * fx;
  return (top * (256 - fy) + bot * fy) >> 16;
}

function fbm(seed: number, x: number, y: number, scale: number): number {
  return (noise2(seed, x, y, scale) * 2 + noise2(seed + 77, x, y, scale >> 1)) / 3;
}

function ellipse(
  g: Grid,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  seed: number,
  wobble: number,
  fn: (x: number, y: number, d: number) => void,
): void {
  for (let y = cy - ry - 3; y <= cy + ry + 3; y++) {
    for (let x = cx - rx - 3; x <= cx + rx + 3; x++) {
      if (x < 0 || x >= g.w || y < 0 || y >= g.h) continue;
      const dx = x - cx;
      const dy = y - cy;
      // d: 0 at centre, 1000 at the rim, pushed around by noise for a lumpy edge.
      let d = Math.floor((dx * dx * 1000) / (rx * rx) + (dy * dy * 1000) / (ry * ry));
      d += ((noise2(seed, x, y, 7) - 512) * wobble) >> 9;
      if (d < 1000) fn(x, y, d);
    }
  }
}

export interface TerrainInfo {
  /** Short description of what the seed rolled, shown in the lobby. */
  traits: string[];
}

export function generateTerrain(seed: number, w = WORLD_W, h = WORLD_H): Grid {
  const g = new Grid(w, h);
  const rng = mulberry32(seed);
  const c = g.cells;

  // --- what kind of cake is this? -----------------------------------------
  const base = 120 + rng.int(-8, 8);
  const amp = rng.int(14, 34);
  const caveT = rng.int(22, 40);
  const islandCount = rng.int(3, 6);
  const tableCount = rng.int(1, 3);
  const mesaCount = rng.int(1, 2);
  const jellyCount = rng.int(4, 8);
  const veinCount = rng.int(3, 6);
  const fudgeLine = rng.int(146, 162);
  const layerH = rng.int(15, 22);
  const s1 = rng.next();
  const s2 = rng.next();
  const s3 = rng.next();

  // --- surface profile, with a tier or two that have sheer sides ------------
  const surf = new Int32Array(w);
  const mesas: { x0: number; x1: number; lift: number }[] = [];
  for (let i = 0; i < mesaCount; i++) {
    const mw = rng.int(38, 70);
    const x0 = rng.int(20, w - 20 - mw);
    mesas.push({ x0, x1: x0 + mw, lift: rng.int(18, 34) });
  }
  for (let x = 0; x < w; x++) {
    let y = base;
    y -= ((noise2(s1, x, 0, 64) - 512) * amp) >> 9;
    y -= ((noise2(s1 + 9, x, 0, 21) - 512) * amp) >> 11;
    for (const m of mesas) {
      if (x >= m.x0 && x <= m.x1) {
        const edge = Math.min(x - m.x0, m.x1 - x);
        y -= Math.min(m.lift, edge * 6);
      }
    }
    surf[x] = Math.max(40, Math.min(h - 30, y));
  }

  // --- fill with strata -------------------------------------------------------
  for (let x = 0; x < w; x++) {
    const drip = 2 + (noise2(s2, x, 0, 5) > 700 ? 3 : 0) + (noise2(s2, x, 0, 11) >> 8);
    for (let y = surf[x]; y < h; y++) {
      const d = y - surf[x];
      const wob = (noise2(s2 + 3, x, y, 40) - 512) >> 6;
      let m = SPONGE;
      if (d < drip) m = ICING;
      else if ((((y + wob) % layerH) + layerH) % layerH < 2) m = CREAM;
      if (y + wob > fudgeLine) m = FUDGE;
      else if (d > 10 && noise2(s2 + 5, x, y, 13) > 800) m = FUDGE;
      c[y * w + x] = m;
    }
  }

  // --- caves: contour lines of a noise field make winding tunnels -----------
  for (let y = 0; y < h - 6; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (c[i] === AIR) continue;
      const d = y - surf[x];
      // Some stretches let caves break the surface, most keep a roof on.
      const roof = noise2(s3 + 1, x, 0, 30) > 640 ? 0 : 7;
      if (d < roof) continue;
      const n = fbm(s3, x, y * 2, 36);
      const t = d < 14 ? (caveT * (d + 6)) / 20 : caveT;
      if (Math.abs(n - 512) < t) c[i] = AIR;
    }
  }
  // a few proper caverns
  const cavernCount = rng.int(2, 4);
  for (let k = 0; k < cavernCount; k++) {
    const cx = rng.int(30, w - 30);
    const cy = Math.min(h - 22, surf[cx] + rng.int(22, 50));
    ellipse(g, cx, cy, rng.int(14, 26), rng.int(6, 11), s3 + k, 420, (x, y) => {
      if (y < h - 6) c[y * w + x] = AIR;
    });
  }

  // --- candy veins: indestructible streaks that block drills, anchor chunks -
  for (let k = 0; k < veinCount; k++) {
    let x = rng.int(15, w - 15);
    let y = rng.int(base + 10, h - 16);
    const len = rng.int(16, 38);
    const dir = rng.chance(1, 2) ? 1 : -1;
    const rise = rng.int(-1, 1);
    for (let j = 0; j < len; j++) {
      for (let t = 0; t < 2; t++) {
        const xx = x;
        const yy = y + t;
        if (xx > 0 && xx < w && yy > 0 && yy < h && c[yy * w + xx] !== AIR) c[yy * w + xx] = CANDY;
      }
      x += dir;
      if (j % 3 === 0) y += rise;
    }
  }

  // --- tables: a candy pillar holding up a slab. Shelter below, perch above -
  for (let k = 0; k < tableCount; k++) {
    const px = rng.int(30, w - 30);
    const top = surf[px] - rng.int(20, 32);
    if (top < 26) continue;
    const half = rng.int(11, 19);
    for (let y = top; y < surf[px] + 6 && y < h; y++) {
      for (let x = px - 1; x <= px + 1; x++) c[y * w + x] = CANDY;
    }
    for (let x = px - half; x <= px + half; x++) {
      if (x < 2 || x >= w - 2) continue;
      c[top * w + x] = CANDY;
      c[(top + 1) * w + x] = CANDY;
      const mound = 3 + ((noise2(s1 + k, x, 0, 9) * 4) >> 10);
      const edge = Math.min(x - (px - half), px + half - x);
      for (let j = 1; j <= Math.min(mound, edge + 1); j++) {
        c[(top - j) * w + x] = j >= Math.min(mound, edge + 1) - 1 ? ICING : SPONGE;
      }
    }
  }

  // --- floating islands with a candy heart ------------------------------------
  for (let k = 0; k < islandCount; k++) {
    const cx = Math.floor(((k * 2 + 1) * w) / (islandCount * 2)) + rng.int(-18, 18);
    const rx = rng.int(11, 23);
    const ry = rng.int(5, 9);
    if (cx - rx < 4 || cx + rx > w - 4) continue;
    const cy = Math.min(surf[cx] - ry - 20, rng.int(34, 78));
    if (cy < 20) continue;
    const jellyBelly = rng.chance(1, 3);
    ellipse(g, cx, cy, rx, ry, s1 + 100 + k, 300, (x, y, d) => {
      const dy = y - cy;
      if (dy < -(ry >> 1)) return; // flat-ish top
      let m = SPONGE;
      if (dy <= -(ry >> 1) + 2) m = ICING;
      else if (d < 180) m = CANDY;
      else if (jellyBelly && dy > 1 && d > 600) m = JELLY;
      else if (dy === 1) m = CREAM;
      c[y * w + x] = m;
    });
    // make sure the heart exists even on tiny islands
    c[cy * w + cx] = CANDY;
    c[cy * w + cx + 1] = CANDY;
  }

  // --- jelly: trampolines near the surface, ricochet pockets in the deep ----
  for (let k = 0; k < jellyCount; k++) {
    const cx = rng.int(12, w - 12);
    const deep = rng.chance(1, 3);
    const cy = surf[cx] + (deep ? rng.int(18, 40) : rng.int(2, 4));
    ellipse(g, cx, cy, rng.int(6, 11), rng.int(3, 5), s2 + 50 + k, 200, (x, y) => {
      const m = c[y * w + x];
      if (m === SPONGE || m === CREAM || m === ICING || m === FUDGE) c[y * w + x] = JELLY;
    });
  }

  // --- the plate everything sits on --------------------------------------------
  for (let y = h - 4; y < h; y++) for (let x = 0; x < w; x++) c[y * w + x] = PLATE;

  // --- nothing may start unsupported: crumbs left hanging are swept away -----
  for (const group of findLoose(g)) for (const i of group) c[i] = AIR;

  g.loose = false;
  g.touchAll();
  return g;
}

/**
 * Deterministic spawn points: spread across the width, each on the topmost
 * ledge in its column that a pot fits on. Returns FP feet positions.
 */
export function findSpawns(g: Grid, count: number, rng: Rng): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  const margin = 14;
  const span = g.w - margin * 2;
  const order: number[] = [];
  for (let i = 0; i < count; i++) order.push(i);
  for (let i = count - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [order[i], order[j]] = [order[j], order[i]];
  }
  for (let i = 0; i < count; i++) {
    const slotW = Math.floor(span / count);
    const jitter = Math.max(1, slotW >> 2);
    const centre = margin + order[i] * slotW + (slotW >> 1);
    out.push(perch(g, centre + rng.int(-jitter, jitter)));
  }
  return out;
}

/** Topmost standable spot at or near cell column `cx`. */
export function perch(g: Grid, cx: number): { x: number; y: number } {
  for (let off = 0; off < g.w; off++) {
    for (const col of off === 0 ? [cx] : [cx + off, cx - off]) {
      if (col < 4 || col >= g.w - 4) continue;
      const x = col * 256 + 128;
      for (let row = 6; row < g.h - 4; row++) {
        const y = row * 256;
        if (boxFree(g, x, y) && !boxFree(g, x, y + 256)) return { x, y };
      }
    }
  }
  return { x: cx * 256 + 128, y: POT.ht + 256 };
}
