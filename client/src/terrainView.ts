/**
 * Paints the cell grid as cake. The world is cut into canvas tiles; when the
 * grid reports a dirty rectangle only the affected pixels are repainted and
 * only the touched tiles are re-uploaded to the GPU.
 *
 * Edges are smoothed by thresholding a bilinear "solidity" field sampled
 * from the cells, which turns 4px blocks into rounded, outlined shapes
 * without the simulation knowing anything about it.
 */
import * as Phaser from "phaser";
import { CANDY, CREAM, DOUGH, FUDGE, ICING, JELLY, PLATE, SPONGE } from "../../shared/src/content/materials";
import { Grid } from "../../shared/src/grid";
import { THEME } from "../../shared/src/theme";

/** Screen pixels (at zoom 1) per cell. */
export const CELL = 4;
const TILE_W = 60;
const TILE_H = 50;

interface Tile {
  tex: Phaser.Textures.CanvasTexture;
  ctx: CanvasRenderingContext2D;
  cx: number;
  cy: number;
}

function hash(x: number, y: number): number {
  let n = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return (n ^ (n >>> 16)) & 255;
}

export class TerrainView {
  private tiles: Tile[] = [];
  private grid!: Grid;
  private cols: number;
  private rows: number;
  private solid = new Uint8Array(0);

  constructor(scene: Phaser.Scene, w: number, h: number, depth: number) {
    this.cols = Math.ceil(w / TILE_W);
    this.rows = Math.ceil(h / TILE_H);
    for (let ty = 0; ty < this.rows; ty++) {
      for (let tx = 0; tx < this.cols; tx++) {
        const key = `terrain${tx}_${ty}`;
        if (scene.textures.exists(key)) scene.textures.remove(key);
        const tex = scene.textures.createCanvas(key, TILE_W * CELL, TILE_H * CELL)!;
        scene.add.image(tx * TILE_W * CELL, ty * TILE_H * CELL, key).setOrigin(0, 0).setDepth(depth);
        this.tiles.push({ tex, ctx: tex.getContext(), cx: tx * TILE_W, cy: ty * TILE_H });
      }
    }
  }

  setGrid(g: Grid): void {
    this.grid = g;
    g.touchAll();
  }

  /** Repaint whatever changed since the last call. */
  update(): void {
    const g = this.grid;
    if (!g || g.dx1 < g.dx0) return;
    // One extra cell all round: a changed cell alters its neighbours' edges.
    const x0 = Math.max(0, g.dx0 - 1);
    const y0 = Math.max(0, g.dy0 - 2);
    const x1 = Math.min(g.w - 1, g.dx1 + 1);
    const y1 = Math.min(g.h - 1, g.dy1 + 2);
    g.clearDirty();
    const img = this.paint(x0, y0, x1, y1);
    for (const t of this.tiles) {
      if (t.cx > x1 || t.cy > y1 || t.cx + TILE_W <= x0 || t.cy + TILE_H <= y0) continue;
      t.ctx.putImageData(img, (x0 - t.cx) * CELL, (y0 - t.cy) * CELL);
      t.tex.refresh();
    }
  }

  private paint(x0: number, y0: number, x1: number, y1: number): ImageData {
    const g = this.grid;
    const M = THEME.materials;
    const w = (x1 - x0 + 1) * CELL;
    const h = (y1 - y0 + 1) * CELL;
    const img = new ImageData(w, h);
    const d = img.data;
    const cells = g.cells;
    const gw = g.w;
    const gh = g.h;
    // Material lookup that clamps sideways/downwards so the world edge does
    // not get an outline, and treats everything above the sky as air.
    const at = (cx: number, cy: number): number => {
      if (cy < 0) return 0;
      if (cy >= gh) cy = gh - 1;
      if (cx < 0) cx = 0;
      else if (cx >= gw) cx = gw - 1;
      return cells[cy * gw + cx];
    };
    const flav = M.sponge.flavours;
    const out = M.outline;

    for (let py = 0; py < h; py++) {
      const wy = y0 * CELL + py;
      const fy = (wy + 0.5) / CELL - 0.5;
      const iy = Math.floor(fy);
      const ty = fy - iy;
      const cy = Math.floor(wy / CELL);
      for (let px = 0; px < w; px++) {
        const wx = x0 * CELL + px;
        const fx = (wx + 0.5) / CELL - 0.5;
        const ix = Math.floor(fx);
        const tx = fx - ix;
        const a = at(ix, iy);
        const b = at(ix + 1, iy);
        const c = at(ix, iy + 1);
        const e = at(ix + 1, iy + 1);
        const s = (a ? (1 - tx) * (1 - ty) : 0) + (b ? tx * (1 - ty) : 0) + (c ? (1 - tx) * ty : 0) + (e ? tx * ty : 0);
        const o = (py * w + px) * 4;
        if (s < 0.5) continue; // transparent
        if (s < 0.66) {
          d[o] = out[0];
          d[o + 1] = out[1];
          d[o + 2] = out[2];
          d[o + 3] = 255;
          continue;
        }
        const cx = Math.floor(wx / CELL);
        // The pixel's own cell if solid, otherwise the heaviest neighbour.
        let m = at(cx, cy);
        if (!m) m = tx < 0.5 ? (ty < 0.5 ? a || b || c || e : c || e || a || b) : ty < 0.5 ? b || a || e || c : e || c || b || a;
        let r = 0;
        let gr = 0;
        let bl = 0;
        const n2 = hash(wx >> 1, wy >> 1);
        const nc = hash(cx + 7919, cy);
        let speck = 0;
        switch (m) {
          case SPONGE: {
            const wob = Math.round(Math.sin(cx * 0.13) * 2 + Math.sin(cx * 0.041) * 3);
            const ly = cy + wob;
            const band = ((ly % M.layer) + M.layer) % M.layer;
            if (band === 0) {
              [r, gr, bl] = M.cream.color; // a line of filling between layers
            } else {
              [r, gr, bl] = flav[Math.floor(ly / M.layer) % flav.length];
              speck = M.sponge.speckle;
              if (nc < M.sponge.holes * 256 && (wx & 3) > 0 && (wx & 3) < 3 && (wy & 3) > 0 && (wy & 3) < 3) speck = -60 - speck;
            }
            break;
          }
          case CREAM:
            [r, gr, bl] = M.cream.color;
            speck = M.cream.speckle;
            break;
          case FUDGE:
            [r, gr, bl] = M.fudge.color;
            speck = M.fudge.speckle;
            if (nc < M.fudge.chips * 256 && (wx & 3) < 2 && (wy & 3) < 2) speck = 70;
            break;
          case JELLY: {
            [r, gr, bl] = M.jelly.color;
            if (((wx - wy) & 15) < 3) {
              const sh = M.jelly.shine;
              r = (r + sh[0]) >> 1;
              gr = (gr + sh[1]) >> 1;
              bl = (bl + sh[2]) >> 1;
            }
            speck = M.jelly.speckle;
            break;
          }
          case CANDY:
            [r, gr, bl] = Math.floor((wx + wy) / M.candy.stripe) & 1 ? M.candy.a : M.candy.b;
            break;
          case PLATE:
            [r, gr, bl] = Math.floor((wx + (wy >> 2) * 5) / M.plate.stripe) % 3 === 0 && (wy & 7) < 5 ? M.plate.b : M.plate.a;
            break;
          case ICING:
            [r, gr, bl] = M.icing.color;
            if (n2 < M.icing.sprinkleRate * 256) [r, gr, bl] = M.icing.sprinkles[hash(wx >> 1, 99 + (wy >> 1)) % M.icing.sprinkles.length];
            break;
          case DOUGH:
            [r, gr, bl] = M.dough.color;
            speck = M.dough.speckle;
            break;
          default:
            [r, gr, bl] = M.cream.color;
        }
        // Speckle, then cheap lighting: lit top edges, shaded undersides,
        // and a soft dark rim just inside the outline.
        let k = speck < 0 ? speck : speck ? ((n2 * speck) >> 8) - (speck >> 1) : 0;
        if (speck > 60) k = speck;
        if (!at(cx, cy - 1)) k += 20;
        else if (!at(cx, cy + 1)) k -= 26;
        if (s < 0.8) k -= 22;
        d[o] = Math.max(0, Math.min(255, r + k));
        d[o + 1] = Math.max(0, Math.min(255, gr + k));
        d[o + 2] = Math.max(0, Math.min(255, bl + k));
        d[o + 3] = 255;
      }
    }
    return img;
  }
}
