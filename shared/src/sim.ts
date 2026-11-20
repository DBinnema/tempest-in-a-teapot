/**
 * RESOLVE: the deterministic fixed-timestep simulation of everyone's queued
 * lumps going off at once. The server runs it to completion in one go; each
 * client runs the very same code against the very same inputs to replay it
 * (and, during PLAN, runs it with only its own plan to draw previews).
 *
 * Inputs: grid, pots, plans, tea level. Output: mutated grid/pots + an event
 * log. No randomness, no wall-clock, no iteration over unordered containers.
 */
import { AIR, DOUGH, MATERIALS } from "./content/materials";
import { POT } from "./content/tanks";
import { WEAPON_BY_ID, WeaponDef } from "./content/weapons";
import { clampInt, isqrt, launchVel } from "./fixed";
import { addBlob, carveCircle, findLoose, Grid } from "./grid";
import { atRest, ensureFree, stepTank, Tank, tankCells } from "./tank";

export const TICK_HZ = 60;
/** Lump one fires at tick 0, lump two at BEAT2. */
export const BEAT2 = 100;
export const MAX_TICKS = 840;
export const PROJ_G = 5;
export const MIN_POWER = 150;
export const TEA_DAMAGE = 25;

export interface Plan {
  /** weapon id */
  w: string;
  /** tenths of a degree, 0 = right, 900 = up */
  angle: number;
  /** 0..1000 */
  power: number;
}
export type PlanPair = [Plan | null, Plan | null];

/** Validate an untrusted plan slot. Returns null for anything malformed. */
export function sanitizePlan(raw: unknown): Plan | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const w = typeof r.w === "string" ? WEAPON_BY_ID[r.w] : undefined;
  if (!w || w.hidden) return null;
  return { w: w.id, angle: clampInt(r.angle, 0, 3599, 900), power: clampInt(r.power, MIN_POWER, 1000, 600) };
}

export interface SimEvent {
  /** tick */
  t: number;
  /** kind */
  k:
    | "fire" | "fizzle" | "jump" | "shield" | "shieldEnd" | "boom" | "build" | "dmg" | "death"
    | "block" | "reflect" | "bounce" | "split" | "clash" | "drill" | "lost" | "crack" | "crumbs"
    | "thud" | "land" | "bonk" | "boing" | "end";
  x?: number;
  y?: number;
  r?: number;
  /** actor / attacker pot id (-1 = nobody) */
  a?: number;
  /** victim pot id */
  v?: number;
  /** weapon id */
  w?: string;
  /** amount (damage, cell count, beat index...) */
  n?: number;
  /** cause: blast | fall | crush | tea */
  c?: string;
}

export const FLY = 0;
export const DRILL = 1;
export const REST = 2;

export interface Proj {
  id: number;
  owner: number;
  w: WeaponDef;
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  /** ticks during which it cannot hit its owner */
  safe: number;
  mode: number;
  drillLeft: number;
  /** consecutive drill ticks that carved nothing */
  air: number;
  jelly: number;
  dead: boolean;
}

interface Boom {
  x: number;
  y: number;
  r: number;
  dmg: number;
  owner: number;
  w: string;
}

interface Chunk {
  id: number;
  cells: Int32Array;
  size: number;
  v: number;
  acc: number;
  wait: number;
  owner: number;
  crushed: number[];
}

export function tankCentre(t: Tank): { x: number; y: number } {
  return { x: t.x, y: t.y - (POT.ht >> 1) };
}

export class ResolveSim {
  tick = 0;
  done = false;
  events: SimEvent[] = [];
  projs: Proj[] = [];
  private chunks: Chunk[] = [];
  private pending: Boom[] = [];
  private marks: Int16Array;
  private nextProj = 1;
  private nextChunk = 1;
  private quiet = 0;
  private lastBoomOwner = -1;

  /**
   * @param tanks  sorted by id; mutated in place
   * @param plans  keyed by pot id
   * @param teaRow first flooded row (grid.h = no tea)
   */
  constructor(
    readonly grid: Grid,
    readonly tanks: Tank[],
    readonly plans: Record<number, PlanPair>,
    readonly teaRow: number,
  ) {
    this.marks = new Int16Array(grid.w * grid.h);
    for (const t of tanks) {
      t.vx = 0;
      t.vy = 0;
      t.shield = 0;
      t.cushion = false;
      t.debt = 0;
      t.lastHit = -1;
      ensureFree(grid, t);
    }
    // Anything dug loose during MOVE comes down as the curtain rises.
    grid.loose = true;
  }

  get fallingChunks(): number {
    return this.chunks.length;
  }

  runToEnd(): SimEvent[] {
    while (!this.done) this.step();
    return this.events;
  }

  private ev(e: Omit<SimEvent, "t">): void {
    (e as SimEvent).t = this.tick;
    this.events.push(e as SimEvent);
  }

  step(): void {
    if (this.done) return;
    if (this.tick === 0) this.fireBeat(0);
    if (this.tick === BEAT2) this.fireBeat(1);

    const count = this.projs.length; // newly spawned ones wait a tick
    for (let i = 0; i < count; i++) if (!this.projs[i].dead) this.stepProj(this.projs[i]);
    this.clashes();
    // Explosions are queued and settled in order, so a blast that kills a pot
    // (whose shattering queues another blast) chains within the same tick.
    for (let i = 0; i < this.pending.length && i < 400; i++) this.explode(this.pending[i]);
    this.pending.length = 0;

    for (const t of this.tanks) {
      if (!t.alive) continue;
      stepTank(this.grid, t, 0, true, (kind, tank, speed) => {
        if (kind === "land") {
          this.ev({ k: "land", v: tank.id, x: tank.x, y: tank.y, n: speed });
          if (speed > POT.fallSafe) this.hurt(tank, Math.trunc((speed - POT.fallSafe) / 10) + 1, tank.lastHit, "", "fall");
        } else this.ev({ k: kind, v: tank.id, x: tank.x, y: tank.y, n: speed });
      });
      if (t.shield > 0 && --t.shield === 0) this.ev({ k: "shieldEnd", a: t.id });
    }

    this.stepChunks();
    if (this.projs.length > 64) this.projs = this.projs.filter((p) => !p.dead);

    this.tick++;
    const busy =
      this.tick <= BEAT2 ||
      this.pending.length > 0 ||
      this.chunks.length > 0 ||
      this.grid.loose ||
      this.projs.some((p) => !p.dead) ||
      this.tanks.some((t) => !atRest(t));
    this.quiet = busy ? 0 : this.quiet + 1;
    if (this.quiet >= 36 || this.tick >= MAX_TICKS) this.finish();
  }

  private finish(): void {
    for (const p of this.projs) p.dead = true;
    // Land anything still in the air so the grid is settled for next round.
    for (let guard = 0; this.chunks.length && guard < 400; guard++) this.stepChunks();
    for (const t of this.tanks) {
      if (t.alive && Math.floor((t.y - 1) / 256) > this.teaRow) this.hurt(t, TEA_DAMAGE, -1, "", "tea");
      t.shield = 0;
    }
    this.pending.length = 0; // a pot that dissolves in tea does not explode
    this.ev({ k: "end" });
    this.done = true;
  }

  // ------------------------------------------------------------------ lumps

  private fireBeat(beat: number): void {
    for (const t of this.tanks) {
      const plan = this.plans[t.id]?.[beat];
      if (!plan) continue;
      const w = WEAPON_BY_ID[plan.w];
      if (!w) continue;
      if (!t.alive) {
        // The plan died with the pot. The recap makes a point of it.
        this.ev({ k: "fizzle", a: t.id, w: w.id, n: beat });
        continue;
      }
      const c = tankCentre(t);
      const [vx, vy] = launchVel(plan.angle, plan.power, w.speed);
      if (vx) t.facing = vx > 0 ? 1 : -1;
      this.ev({ k: "fire", a: t.id, w: w.id, n: beat, x: c.x, y: c.y, r: plan.angle });
      if (w.kind === "jump") {
        t.vx = vx;
        t.vy = vy;
        t.grounded = false;
        t.cushion = true;
        this.ev({ k: "jump", a: t.id, x: t.x, y: t.y });
      } else if (w.kind === "shield") {
        t.shield = w.fuse ?? 180;
        this.ev({ k: "shield", a: t.id, n: t.shield });
      } else {
        const [mx, my] = launchVel(plan.angle, 1000, 820);
        let x = c.x + mx;
        let y = c.y + my;
        // Spout jammed against a wall: the shot starts inside the pot and
        // goes off in its own face. Serves it right.
        if (this.grid.solid(Math.floor(x / 256), Math.floor(y / 256))) {
          x = c.x;
          y = c.y;
        }
        this.spawn(t.id, w, x, y, vx, vy);
      }
    }
  }

  private spawn(owner: number, w: WeaponDef, x: number, y: number, vx: number, vy: number): Proj {
    const p: Proj = {
      id: this.nextProj++,
      owner,
      w,
      x,
      y,
      vx,
      vy,
      age: 0,
      safe: 16,
      mode: FLY,
      drillLeft: w.drillTicks ?? 0,
      air: 0,
      jelly: 0,
      dead: false,
    };
    this.projs.push(p);
    return p;
  }

  // ------------------------------------------------------------ projectiles

  private stepProj(p: Proj): void {
    const g = this.grid;
    const w = p.w;
    p.age++;
    if (p.safe > 0) p.safe--;
    if (w.fuse && p.age >= w.fuse) return this.detonate(p, p.x, p.y);
    if (p.mode === DRILL) return this.stepDrill(p);
    if (p.mode === REST) {
      if (g.solid(Math.floor(p.x / 256), Math.floor(p.y / 256) + 1)) return;
      p.mode = FLY;
    }
    p.vy += PROJ_G;
    if (w.kind === "cluster" && p.age >= 14 && p.vy >= 0) return this.split(p);

    const n = Math.max(1, Math.ceil(Math.max(Math.abs(p.vx), Math.abs(p.vy)) / 100));
    const sx = p.x;
    const sy = p.y;
    for (let i = 1; i <= n; i++) {
      const nx = sx + Math.trunc((p.vx * i) / n);
      const ny = sy + Math.trunc((p.vy * i) / n);
      const cx = Math.floor(nx / 256);
      const cy = Math.floor(ny / 256);
      if (cx < 0 || cx >= g.w || cy >= g.h) {
        p.dead = true;
        this.ev({ k: "lost", a: p.owner, w: w.id, x: nx, y: ny });
        return;
      }
      if (this.reflect(p, nx, ny)) {
        p.x = nx;
        p.y = ny;
        return;
      }
      if (this.tankAt(nx, ny, p)) return this.detonate(p, nx, ny);
      if (cy >= 0 && g.cells[cy * g.w + cx] !== AIR) {
        const mat = MATERIALS[g.cells[cy * g.w + cx]];
        const jellyBounce = mat.bouncy && p.jelly < 3;
        if (w.kind === "bouncer" || jellyBounce) {
          // Work out which face we hit from the last free position.
          const pcx = Math.floor(p.x / 256);
          const pcy = Math.floor(p.y / 256);
          let fx = g.solid(cx, pcy);
          let fy = g.solid(pcx, cy);
          if (!fx && !fy) fx = fy = true;
          const keep = jellyBounce ? 92 : (w.bounce ?? 50);
          const speed = Math.abs(p.vx) + Math.abs(p.vy);
          p.vx = fx ? -Math.trunc((p.vx * keep) / 100) : Math.trunc((p.vx * 9) / 10);
          if (fy) p.vy = -Math.trunc((p.vy * keep) / 100);
          if (jellyBounce) p.jelly++;
          if (speed > 70) this.ev({ k: "bounce", a: p.owner, x: p.x, y: p.y, n: jellyBounce ? 1 : 0, w: w.id });
          if (!jellyBounce && fy && Math.abs(p.vx) + Math.abs(p.vy) < 36) {
            p.vx = 0;
            p.vy = 0;
            p.mode = REST;
          }
          return;
        }
        if (w.kind === "drill" && p.drillLeft > 0 && mat.tough > 0) {
          const len = Math.max(1, isqrt(p.vx * p.vx + p.vy * p.vy));
          p.vx = Math.trunc((p.vx * 150) / len);
          p.vy = Math.trunc((p.vy * 150) / len);
          p.mode = DRILL;
          p.air = 0;
          p.x = nx;
          p.y = ny;
          this.ev({ k: "drill", a: p.owner, x: nx, y: ny });
          return;
        }
        // Builders set down at the last free spot; blasts bite into the wall.
        if (w.kind === "builder") return this.detonate(p, p.x, p.y);
        return this.detonate(p, nx, ny);
      }
      p.x = nx;
      p.y = ny;
    }
  }

  private stepDrill(p: Proj): void {
    const g = this.grid;
    const ox = p.x;
    const oy = p.y;
    p.x += p.vx;
    p.y += p.vy;
    const cx = Math.floor(p.x / 256);
    const cy = Math.floor(p.y / 256);
    if (cx < 0 || cx >= g.w || cy >= g.h) {
      p.dead = true;
      this.ev({ k: "lost", a: p.owner, w: p.w.id, x: p.x, y: p.y });
      return;
    }
    if (this.tankAt(p.x, p.y, p)) return this.detonate(p, p.x, p.y);
    const carved = carveCircle(g, p.x, p.y, p.w.tunnel ?? 700);
    // Still solid after carving = candy or plate. The corkscrew snaps.
    if (g.solid(cx, cy)) return this.detonate(p, ox, oy);
    if (--p.drillLeft <= 0) return this.detonate(p, p.x, p.y);
    if (carved === 0) {
      // Broke through into open air: fly on, and bore again on re-entry.
      if (++p.air >= 4) {
        p.mode = FLY;
        p.vx *= 2;
        p.vy *= 2;
      }
    } else p.air = 0;
  }

  private split(p: Proj): void {
    p.dead = true;
    const n = p.w.bomblets ?? 5;
    const sub = WEAPON_BY_ID.bomblet;
    this.ev({ k: "split", a: p.owner, x: p.x, y: p.y, w: p.w.id });
    for (let i = 0; i < n; i++) {
      const off = i * 2 - (n - 1); // -5,-3,-1,1,3,5 for six
      const b = this.spawn(p.owner, sub, p.x, p.y, p.vx + off * 22, p.vy - 40 + Math.abs(off) * 10);
      b.safe = 6;
    }
  }

  /** Reflective domes: bounce the shot back and hand ownership to the dome's pot. */
  private reflect(p: Proj, nx: number, ny: number): boolean {
    for (const t of this.tanks) {
      if (!t.alive || t.shield <= 0 || t.id === p.owner) continue;
      const R = WEAPON_BY_ID.cloche.radius;
      const dx = nx - t.x;
      const dy = ny - (t.y - (POT.ht >> 1));
      const d2 = dx * dx + dy * dy;
      if (d2 >= R * R || d2 === 0) continue;
      const dot = p.vx * dx + p.vy * dy;
      if (dot >= 0) continue; // already heading out
      const k = (2 * dot) / d2;
      p.vx = Math.trunc(p.vx - k * dx);
      p.vy = Math.trunc(p.vy - k * dy);
      this.ev({ k: "reflect", a: t.id, v: p.owner, x: nx, y: ny, w: p.w.id });
      p.owner = t.id;
      p.safe = 20;
      if (p.mode === REST) p.mode = FLY;
      return true;
    }
    return false;
  }

  private tankAt(x: number, y: number, p: Proj): Tank | null {
    for (const t of this.tanks) {
      if (!t.alive) continue;
      if (t.id === p.owner && p.safe > 0) continue;
      if (Math.abs(x - t.x) <= POT.hw + 96 && y >= t.y - POT.ht - 96 && y <= t.y + 96) return t;
    }
    return null;
  }

  private detonate(p: Proj, x: number, y: number): void {
    if (p.dead) return;
    p.dead = true;
    p.x = x;
    p.y = y;
    if (p.w.kind === "builder") {
      const boxes = this.tanks.filter((t) => t.alive).map((t) => tankCells(t.x, t.y));
      const n = addBlob(this.grid, x, y, p.w.radius, DOUGH, boxes);
      this.ev({ k: "build", a: p.owner, x, y, r: p.w.radius, n, w: p.w.id });
      return;
    }
    this.pending.push({ x, y, r: p.w.radius, dmg: p.w.damage, owner: p.owner, w: p.w.id });
  }

  /** Two shots from different pots meeting mid-air set each other off. */
  private clashes(): void {
    const ps = this.projs;
    const lim = 360 * 360;
    for (let i = 0; i < ps.length; i++) {
      const a = ps[i];
      if (a.dead || a.mode !== FLY) continue;
      for (let j = i + 1; j < ps.length; j++) {
        const b = ps[j];
        if (b.dead || b.mode !== FLY || b.owner === a.owner) continue;
        // closest approach over the last tick, treating both as straight lines
        const rvx = a.vx - b.vx;
        const rvy = a.vy - b.vy;
        const px = a.x - a.vx - (b.x - b.vx);
        const py = a.y - a.vy - (b.y - b.vy);
        const vv = rvx * rvx + rvy * rvy;
        let t = vv === 0 ? 0 : -(px * rvx + py * rvy) / vv;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = px + rvx * t;
        const dy = py + rvy * t;
        if (dx * dx + dy * dy > lim) continue;
        const mx = Math.trunc((a.x + b.x) / 2);
        const my = Math.trunc((a.y + b.y) / 2);
        this.ev({ k: "clash", a: a.owner, v: b.owner, x: mx, y: my });
        this.detonate(a, mx, my);
        this.detonate(b, mx, my);
        break;
      }
    }
  }

  // --------------------------------------------------------------- blasts

  private explode(b: Boom): void {
    const g = this.grid;
    const n = carveCircle(g, b.x, b.y, b.r);
    this.lastBoomOwner = b.owner;
    this.ev({ k: "boom", x: b.x, y: b.y, r: b.r, a: b.owner, w: b.w, n });
    const R = Math.trunc((b.r * 13) / 10);
    for (const t of this.tanks) {
      if (!t.alive) continue;
      const px = b.x < t.x - POT.hw ? t.x - POT.hw : b.x > t.x + POT.hw ? t.x + POT.hw : b.x;
      const py = b.y < t.y - POT.ht ? t.y - POT.ht : b.y > t.y ? t.y : b.y;
      const d = isqrt((px - b.x) * (px - b.x) + (py - b.y) * (py - b.y));
      if (d >= R) continue;
      if (t.shield > 0) {
        this.ev({ k: "block", a: t.id, v: b.owner, x: t.x, y: t.y, w: b.w });
        continue;
      }
      const kx = t.x - b.x;
      const ky = t.y - (POT.ht >> 1) - b.y - 200; // biased upward: blasts toss pots
      const len = Math.max(64, isqrt(kx * kx + ky * ky));
      const force = Math.trunc((b.dmg * 7 * (R - d)) / R);
      t.vx += Math.trunc((kx * force) / len);
      t.vy += Math.trunc((ky * force) / len) - (force >> 2);
      t.grounded = false;
      if (b.owner !== t.id) t.lastHit = b.owner;
      this.hurt(t, Math.max(1, Math.trunc((b.dmg * (R - d)) / R)), b.owner, b.w, "blast");
    }
    // Bouncers get kicked around by other blasts instead of going off.
    for (const p of this.projs) {
      if (p.dead || p.w.kind !== "bouncer") continue;
      const dx = p.x - b.x;
      const dy = p.y - b.y - 128;
      const d = isqrt(dx * dx + dy * dy);
      if (d >= R) continue;
      const force = Math.trunc((b.dmg * 9 * (R - d)) / R);
      const len = Math.max(64, d);
      p.vx += Math.trunc((dx * force) / len);
      p.vy += Math.trunc((dy * force) / len);
      p.mode = FLY;
    }
  }

  private hurt(t: Tank, amount: number, attacker: number, w: string, cause: string): void {
    if (!t.alive || amount <= 0) return;
    t.hp -= amount;
    this.ev({ k: "dmg", v: t.id, a: attacker, n: amount, w, c: cause, x: t.x, y: t.y - (POT.ht >> 1) });
    if (t.hp > 0) return;
    t.hp = 0;
    t.alive = false;
    t.shield = 0;
    this.ev({ k: "death", v: t.id, a: attacker, w, c: cause, x: t.x, y: t.y - (POT.ht >> 1) });
    const s = WEAPON_BY_ID.shatter;
    this.pending.push({ x: t.x, y: t.y - (POT.ht >> 1), r: s.radius, dmg: s.damage, owner: attacker, w: s.id });
  }

  // ------------------------------------------------------- falling chunks

  private stepChunks(): void {
    const g = this.grid;
    if (g.loose && this.tick % 2 === 0) {
      g.loose = false;
      for (const group of findLoose(g, this.marks)) {
        const first = group[0];
        if (group.length < 6) {
          for (const i of group) {
            g.cells[i] = AIR;
            g.touch(i % g.w, Math.floor(i / g.w));
          }
          this.ev({ k: "crumbs", x: (first % g.w) * 256, y: Math.floor(first / g.w) * 256, n: group.length });
          continue;
        }
        const id = this.nextChunk++;
        for (const i of group) this.marks[i] = id;
        this.chunks.push({ id, cells: group, size: group.length, v: 0, acc: 0, wait: 0, owner: this.lastBoomOwner, crushed: [] });
        const mid = group[group.length >> 1];
        this.ev({ k: "crack", x: (mid % g.w) * 256, y: Math.floor(mid / g.w) * 256, n: group.length });
      }
    }
    if (!this.chunks.length) return;
    // Lowest first, so a chunk stacked on another sees the space it vacates.
    this.chunks.sort((a, b) => b.cells[b.cells.length - 1] - a.cells[a.cells.length - 1] || a.id - b.id);
    for (const c of this.chunks) {
      c.v = Math.min(16, c.v + 1);
      c.acc += c.v;
      while (c.acc >= 8 && c.size > 0) {
        c.acc -= 8;
        if (!this.dropChunk(c)) break;
      }
    }
    this.chunks = this.chunks.filter((c) => c.size > 0);
  }

  /** Move a chunk one cell down. Returns false if it landed or must wait. */
  private dropChunk(c: Chunk): boolean {
    const g = this.grid;
    const { w, h, cells } = g;
    const marks = this.marks;
    // Forget cells that have been blown away since last step.
    let list = c.cells;
    let live = 0;
    for (let k = 0; k < list.length; k++) {
      const i = list[k];
      if (cells[i] === AIR || marks[i] !== c.id) {
        if (marks[i] === c.id) marks[i] = 0;
      } else list[live++] = i;
    }
    // A pot in the way: the chunk crumbles around it (and hurts) rather than
    // embedding it. The pot ends up in a pot-shaped pocket, buried but free.
    for (const t of this.tanks) {
      if (!t.alive) continue;
      const b = tankCells(t.x, t.y);
      let hit = 0;
      let kept = 0;
      for (let k = 0; k < live; k++) {
        const i = list[k];
        const x = i % w;
        const y = Math.floor(i / w) + 1;
        if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) {
          cells[i] = AIR;
          marks[i] = 0;
          g.touch(x, y - 1);
          hit++;
        } else list[kept++] = i;
      }
      live = kept;
      if (hit && c.v >= 6 && !c.crushed.includes(t.id)) {
        c.crushed.push(t.id);
        this.hurt(t, Math.min(34, 6 + Math.trunc(c.size / 30)), c.owner === t.id ? -1 : c.owner, "", "crush");
      }
    }
    if (live !== list.length) {
      list = list.subarray(0, live);
      c.cells = list;
      if (live === 0) {
        c.size = 0;
        return false;
      }
    }
    let blocked = false;
    let waiting = false;
    for (let k = 0; k < live; k++) {
      const j = list[k] + w;
      if (j >= w * h) {
        blocked = true;
        break;
      }
      if (cells[j] === AIR || marks[j] === c.id) continue;
      if (marks[j] !== 0) waiting = true;
      else {
        blocked = true;
        break;
      }
    }
    if (!blocked && waiting && ++c.wait < 40) {
      c.v = 0;
      return false;
    }
    if (blocked || waiting) {
      for (let k = 0; k < live; k++) marks[list[k]] = 0;
      const mid = list[live >> 1];
      this.ev({ k: "thud", x: (mid % w) * 256, y: Math.floor(mid / w) * 256, n: live, r: c.v });
      c.size = 0;
      g.loose = true;
      return false;
    }
    c.wait = 0;
    for (let k = live - 1; k >= 0; k--) {
      const i = list[k];
      const j = i + w;
      cells[j] = cells[i];
      cells[i] = AIR;
      marks[j] = c.id;
      marks[i] = 0;
      list[k] = j;
    }
    // dirty rect: the chunk's bounding rows/cols (plus the row it left)
    const top = Math.floor(list[0] / w) - 1;
    const bot = Math.floor(list[live - 1] / w);
    let x0 = w;
    let x1 = 0;
    for (let k = 0; k < live; k++) {
      const x = list[k] % w;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
    }
    g.touch(x0, top);
    g.touch(x1, bot);
    return true;
  }
}

/** Order-independent digest of the outcome, for client/server agreement checks. */
export function worldHash(g: Grid, tanks: Tank[]): number {
  let h = g.hash();
  for (const t of tanks) {
    for (const v of [t.id, t.x, t.y, t.hp, t.alive ? 1 : 0]) {
      h ^= v & 0xffff;
      h = Math.imul(h, 0x01000193);
      h ^= (v >> 16) & 0xffff;
      h = Math.imul(h, 0x01000193);
    }
  }
  return h >>> 0;
}

/** Convenience used by tests, bots and the server. */
export function runResolve(grid: Grid, tanks: Tank[], plans: Record<number, PlanPair>, teaRow: number): SimEvent[] {
  return new ResolveSim(grid, tanks, plans, teaRow).runToEnd();
}
