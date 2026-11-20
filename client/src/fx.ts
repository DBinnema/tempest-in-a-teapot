/**
 * A tiny particle system drawn into the shared Graphics object. Purely
 * cosmetic: it may use Math.random freely because nothing here feeds back
 * into the simulation.
 */
import * as Phaser from "phaser";

interface P {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: number;
  g: number;
  /** 0 crumb, 1 puff (grows, fades), 2 ring (expands), 3 flash */
  kind: number;
}

export class Particles {
  private list: P[] = [];

  add(kind: number, x: number, y: number, vx: number, vy: number, life: number, size: number, color: number, g = 0): void {
    if (this.list.length > 900) this.list.shift();
    this.list.push({ x, y, vx, vy, life, max: life, size, color, g, kind });
  }

  burst(x: number, y: number, n: number, colors: number[], speed: number, o: { g?: number; life?: number; size?: number; up?: number; kind?: number } = {}): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.25 + Math.random() * 0.75);
      this.add(
        o.kind ?? 0,
        x,
        y,
        Math.cos(a) * v,
        Math.sin(a) * v - (o.up ?? 0),
        (o.life ?? 0.7) * (0.5 + Math.random() * 0.7),
        (o.size ?? 2.4) * (0.6 + Math.random() * 0.8),
        colors[Math.floor(Math.random() * colors.length)],
        o.g ?? 420,
      );
    }
  }

  ring(x: number, y: number, r: number, color: number, life = 0.35): void {
    this.add(2, x, y, 0, 0, life, r, color);
  }

  flash(x: number, y: number, r: number, color: number, life = 0.14): void {
    this.add(3, x, y, 0, 0, life, r, color);
  }

  update(dt: number): void {
    const l = this.list;
    let w = 0;
    for (let i = 0; i < l.length; i++) {
      const p = l[i];
      p.life -= dt;
      if (p.life <= 0) continue;
      p.vy += p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.kind === 1) {
        p.vx *= 1 - 2.5 * dt;
        p.vy *= 1 - 2.5 * dt;
      }
      l[w++] = p;
    }
    l.length = w;
  }

  draw(g: Phaser.GameObjects.Graphics): void {
    for (const p of this.list) {
      const k = p.life / p.max;
      if (p.kind === 0) {
        g.fillStyle(p.color, Math.min(1, k * 2.5));
        g.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      } else if (p.kind === 1) {
        g.fillStyle(p.color, k * 0.6);
        g.fillCircle(p.x, p.y, p.size * (1.6 - k * 0.8));
      } else if (p.kind === 2) {
        g.lineStyle(1 + 4 * k, p.color, k);
        g.strokeCircle(p.x, p.y, p.size * (1.15 - k * 0.6));
      } else {
        g.fillStyle(p.color, k * 0.9);
        g.fillCircle(p.x, p.y, p.size * (0.6 + 0.4 * k));
      }
    }
  }
}
