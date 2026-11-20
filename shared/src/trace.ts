/**
 * A cheap ballistic tracer: where would a plain shell land in a frozen world?
 * Used by bots to aim. (Player previews run the full sim instead.)
 */
import { AIR } from "./content/materials";
import { Grid } from "./grid";
import { PROJ_G } from "./sim";

export function traceShell(g: Grid, x: number, y: number, vx: number, vy: number, maxTicks = 420): { x: number; y: number; hit: boolean } {
  for (let t = 0; t < maxTicks; t++) {
    vy += PROJ_G;
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(vx), Math.abs(vy)) / 100));
    const sx = x;
    const sy = y;
    for (let i = 1; i <= n; i++) {
      const nx = sx + Math.trunc((vx * i) / n);
      const ny = sy + Math.trunc((vy * i) / n);
      const cx = Math.floor(nx / 256);
      const cy = Math.floor(ny / 256);
      if (cx < 0 || cx >= g.w || cy >= g.h) return { x: nx, y: ny, hit: false };
      if (cy >= 0 && g.cells[cy * g.w + cx] !== AIR) return { x: nx, y: ny, hit: true };
      x = nx;
      y = ny;
    }
  }
  return { x, y, hit: false };
}
