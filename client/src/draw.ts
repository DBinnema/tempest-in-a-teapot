/**
 * Procedural art: pots and sweets drawn with Phaser Graphics every frame,
 * plus small canvas icons of the same sweets for the DOM UI. Shapes are
 * chosen by the `art` key in THEME.weapons; colours all come from the theme.
 */
import * as Phaser from "phaser";
import { Glaze, THEME, weaponSkin } from "../../shared/src/theme";

type G = Phaser.GameObjects.Graphics;

export interface PotLook {
  glaze: Glaze;
  /** aim, tenths of a degree (0 = right, 900 = up) */
  aim: number;
  facing: number;
  /** 0..1 vertical squash (landing, recoil) */
  squash: number;
  /** 0..1 white flash when hurt */
  hurt: number;
  alpha: number;
  blink: boolean;
  me: boolean;
}

const INK = THEME.ink;

/** x,y = feet centre, in world pixels. */
export function drawPot(g: G, x: number, y: number, L: PotLook): void {
  const a = L.alpha;
  const sq = 1 - L.squash * 0.28;
  const st = 1 + L.squash * 0.2;
  const rx = 9.5 * st;
  const ry = 7.6 * sq;
  const cy = y - ry - 0.5;
  const rad = (L.aim / 1800) * Math.PI;
  const dx = Math.cos(rad);
  const dy = -Math.sin(rad);
  const side = dx >= 0 ? 1 : -1;
  const body = L.hurt > 0.5 ? 0xffffff : L.glaze.body;

  // handle, on the side away from the spout
  g.lineStyle(4.6, INK, a);
  g.beginPath();
  g.arc(x - side * rx * 0.92, cy, 5, 0, Math.PI * 2);
  g.strokePath();
  g.lineStyle(2.2, L.glaze.dark, a);
  g.beginPath();
  g.arc(x - side * rx * 0.92, cy, 5, 0, Math.PI * 2);
  g.strokePath();

  // spout: an outlined stub that points along the aim
  const sx = x + dx * rx * 0.55;
  const sy = cy + dy * ry * 0.55;
  const ex = x + dx * (rx + 7.5);
  const ey = cy + dy * (ry + 7.5);
  g.lineStyle(7.4, INK, a);
  g.lineBetween(sx, sy, ex, ey);
  g.lineStyle(4.6, L.glaze.body, a);
  g.lineBetween(sx, sy, ex - dx * 0.8, ey - dy * 0.8);
  g.fillStyle(INK, a);
  g.fillCircle(ex, ey, 2.2);

  // body
  g.fillStyle(INK, a);
  g.fillEllipse(x, cy, rx * 2 + 2.8, ry * 2 + 2.8);
  g.fillStyle(body, a);
  g.fillEllipse(x, cy, rx * 2, ry * 2);
  g.fillStyle(L.glaze.dark, a * 0.55);
  g.fillEllipse(x, cy + ry * 0.55, rx * 1.7, ry * 0.8);
  g.fillStyle(L.glaze.light, a * 0.9);
  g.fillEllipse(x - rx * 0.35, cy - ry * 0.45, rx * 0.7, ry * 0.45);
  // a painted band, so pots read as crockery rather than blobs
  g.lineStyle(1.2, 0xffffff, a * 0.7);
  g.lineBetween(x - rx * 0.8, cy + ry * 0.12, x + rx * 0.8, cy + ry * 0.12);

  // lid + knob
  g.fillStyle(INK, a);
  g.fillEllipse(x, cy - ry * 0.95, rx * 1.25 + 2.4, 5.4);
  g.fillCircle(x, cy - ry - 3.4, 3.2);
  g.fillStyle(L.glaze.dark, a);
  g.fillEllipse(x, cy - ry * 0.95, rx * 1.25, 3.2);
  g.fillStyle(L.me ? 0xffffff : L.glaze.light, a);
  g.fillCircle(x, cy - ry - 3.4, 1.9);

  // face
  const fx = x + side * rx * 0.3;
  const fy = cy - ry * 0.12;
  if (L.blink) {
    g.lineStyle(1.3, INK, a);
    g.lineBetween(fx - 3.6, fy, fx - 1.2, fy);
    g.lineBetween(fx + 1.2, fy, fx + 3.6, fy);
  } else {
    g.fillStyle(0xffffff, a);
    g.fillCircle(fx - 2.4, fy, 2.1);
    g.fillCircle(fx + 2.4, fy, 2.1);
    g.fillStyle(INK, a);
    g.fillCircle(fx - 2.4 + dx * 0.9, fy + dy * 0.9, 1.05);
    g.fillCircle(fx + 2.4 + dx * 0.9, fy + dy * 0.9, 1.05);
  }
}

/** A sweet in flight. x,y in world pixels; spin in radians. */
export function drawSweet(g: G, art: string, color: number, x: number, y: number, spin: number, scale = 1, alpha = 1): void {
  const s = scale;
  const rot = (px: number, py: number): [number, number] => [x + (px * Math.cos(spin) - py * Math.sin(spin)) * s, y + (px * Math.sin(spin) + py * Math.cos(spin)) * s];
  const poly = (pts: number[][], fill: number) => {
    const p = pts.map(([px, py]) => {
      const [qx, qy] = rot(px, py);
      return new Phaser.Math.Vector2(qx, qy);
    });
    g.fillStyle(fill, alpha);
    g.fillPoints(p, true);
    g.lineStyle(1.3, INK, alpha);
    g.strokePoints(p, true);
  };
  switch (art) {
    case "cube":
      poly([[-3.2, -3.2], [3.2, -3.2], [3.2, 3.2], [-3.2, 3.2]], color);
      break;
    case "ball": {
      g.fillStyle(INK, alpha);
      g.fillCircle(x, y, 5 * s);
      g.fillStyle(color, alpha);
      g.fillCircle(x, y, 3.9 * s);
      const [hx, hy] = rot(1.6, -1.6);
      g.fillStyle(0xffffff, alpha * 0.9);
      g.fillCircle(hx, hy, 1.3 * s);
      const [kx, ky] = rot(-1.8, 1.4);
      g.fillStyle(THEME.ui ? 0xe8425a : color, alpha * 0.9);
      g.fillCircle(kx, ky, 1.1 * s);
      break;
    }
    case "star": {
      const pts: number[][] = [];
      for (let i = 0; i < 10; i++) {
        const r = i & 1 ? 2.1 : 4.8;
        pts.push([Math.cos((i * Math.PI) / 5) * r, Math.sin((i * Math.PI) / 5) * r]);
      }
      poly(pts, color);
      break;
    }
    case "screw":
      poly([[-5.5, -2.2], [1.5, -2.2], [5.8, 0], [1.5, 2.2], [-5.5, 2.2]], color);
      g.lineStyle(1, INK, alpha);
      for (let i = -4; i <= 1; i += 2.4) {
        const [ax, ay] = rot(i, -2.2);
        const [bx, by] = rot(i + 1.6, 2.2);
        g.lineBetween(ax, ay, bx, by);
      }
      break;
    case "blob":
      g.fillStyle(INK, alpha);
      g.fillEllipse(x, y, 11.5 * s, 9.5 * s);
      g.fillStyle(color, alpha);
      g.fillEllipse(x, y, 9.2 * s, 7.2 * s);
      break;
    default:
      g.fillStyle(INK, alpha);
      g.fillCircle(x, y, 3.6 * s);
      g.fillStyle(color, alpha);
      g.fillCircle(x, y, 2.6 * s);
  }
}

const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;
const iconCache = new Map<string, string>();

/** Data-URL icon of a weapon for buttons and recap rows. */
export function weaponIcon(id: string): string {
  const hit = iconCache.get(id);
  if (hit) return hit;
  const skin = weaponSkin(id);
  const c = document.createElement("canvas");
  c.width = c.height = 48;
  const x = c.getContext("2d")!;
  const ink = hex(INK);
  x.translate(24, 24);
  x.lineWidth = 3;
  x.lineJoin = "round";
  x.strokeStyle = ink;
  x.fillStyle = hex(skin.color);
  const done = () => {
    x.fill();
    x.stroke();
  };
  switch (skin.art) {
    case "cube":
      x.rotate(0.35);
      x.beginPath();
      x.rect(-11, -11, 22, 22);
      done();
      x.fillStyle = "rgba(59,31,43,0.15)";
      x.fillRect(-11, 2, 22, 9);
      break;
    case "ball":
      x.beginPath();
      x.arc(0, 0, 14, 0, 7);
      done();
      x.fillStyle = hex(THEME.glazes[1].body);
      x.beginPath();
      x.arc(-4, 5, 4, 0, 7);
      x.fill();
      x.fillStyle = "#fff";
      x.beginPath();
      x.arc(5, -5, 4, 0, 7);
      x.fill();
      break;
    case "star":
      x.beginPath();
      for (let i = 0; i < 10; i++) {
        const r = i & 1 ? 7 : 16;
        x.lineTo(Math.cos((i * Math.PI) / 5 - 1.57) * r, Math.sin((i * Math.PI) / 5 - 1.57) * r);
      }
      x.closePath();
      done();
      break;
    case "screw":
      x.rotate(-0.6);
      x.beginPath();
      x.moveTo(-17, -6);
      x.lineTo(6, -6);
      x.lineTo(18, 0);
      x.lineTo(6, 6);
      x.lineTo(-17, 6);
      x.closePath();
      done();
      x.lineWidth = 2;
      for (let i = -13; i < 6; i += 6) {
        x.beginPath();
        x.moveTo(i, -6);
        x.lineTo(i + 4, 6);
        x.stroke();
      }
      break;
    case "blob":
      x.beginPath();
      x.ellipse(0, 3, 17, 12, 0, 0, 7);
      done();
      x.beginPath();
      x.ellipse(-3, -7, 9, 7, 0, 0, 7);
      done();
      break;
    case "puff":
      for (const [px, py, r] of [[-8, 4, 9], [6, 6, 8], [0, -6, 10]]) {
        x.beginPath();
        x.arc(px, py, r, 0, 7);
        done();
      }
      x.fillStyle = hex(skin.color);
      x.beginPath();
      x.arc(0, 2, 9, 0, 7);
      x.fill();
      break;
    case "dome":
      x.beginPath();
      x.arc(0, 8, 17, Math.PI, 0);
      x.closePath();
      x.globalAlpha = 0.75;
      x.fill();
      x.globalAlpha = 1;
      x.stroke();
      x.beginPath();
      x.arc(0, -12, 3.5, 0, 7);
      done();
      break;
  }
  const url = c.toDataURL();
  iconCache.set(id, url);
  return url;
}

/** Sky: gradient + gingham + distant crockery, painted once to a texture. */
export function paintSky(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const S = THEME.sky;
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, hex(S.top));
  grad.addColorStop(1, hex(S.bottom));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = hex(S.check);
  const cs = Math.max(4, Math.round(S.checkSize / 5));
  ctx.globalAlpha = S.checkAlpha;
  for (let x = 0; x < w; x += cs * 2) ctx.fillRect(x, 0, cs, h);
  for (let y = 0; y < h; y += cs * 2) ctx.fillRect(0, y, w, cs);
  ctx.globalAlpha = S.silhouetteAlpha;
  ctx.fillStyle = hex(S.silhouette);
  // a shelf of far-away teapots, cups and a cake stand along the horizon
  const base = h * 0.66;
  let seed = 7;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let x = 10; x < w; ) {
    const kind = Math.floor(rnd() * 3);
    const s = 14 + rnd() * 16;
    ctx.beginPath();
    if (kind === 0) {
      ctx.ellipse(x + s, base - s * 0.8, s, s * 0.8, 0, 0, 7);
      ctx.rect(x + s * 0.7, base - s * 1.9, s * 0.6, s * 0.5);
      ctx.moveTo(x + s * 1.8, base - s);
      ctx.lineTo(x + s * 2.6, base - s * 1.7);
      ctx.lineTo(x + s * 2.6, base - s * 1.3);
      ctx.lineTo(x + s * 1.9, base - s * 0.5);
    } else if (kind === 1) {
      ctx.moveTo(x, base - s);
      ctx.lineTo(x + s * 1.4, base - s);
      ctx.lineTo(x + s * 1.1, base);
      ctx.lineTo(x + s * 0.3, base);
      ctx.closePath();
    } else {
      ctx.rect(x, base - s * 1.5, s * 2.4, s * 0.18);
      ctx.rect(x + s * 1.1, base - s * 1.5, s * 0.2, s * 1.5);
      ctx.ellipse(x + s * 1.2, base - s * 1.9, s * 0.9, s * 0.45, 0, 0, 7);
    }
    ctx.fill();
    x += s * 2.6 + 18 + rnd() * 50;
  }
  ctx.fillRect(0, base, w, h * 0.012);
  ctx.globalAlpha = 1;
}
