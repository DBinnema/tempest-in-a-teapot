/**
 * Bots: enough brain to make a lively table when you are short of friends.
 * They are ordinary seats driven by this module instead of a socket; nothing
 * in the room logic special-cases their plans.
 */
import { POT } from "../../shared/src/content/tanks";
import { WEAPON_BY_ID } from "../../shared/src/content/weapons";
import { launchVel } from "../../shared/src/fixed";
import { Grid } from "../../shared/src/grid";
import { Plan, PlanPair, ResolveSim } from "../../shared/src/sim";
import { IN_DIG, IN_JUMP, IN_LEFT, IN_RIGHT, packTank, Tank, unpackTank } from "../../shared/src/tank";
import { traceShell } from "../../shared/src/trace";

export interface BotBrain {
  dir: number;
  until: number;
  lastX: number;
  stuck: number;
}

export function newBrain(): BotBrain {
  return { dir: 0, until: 0, lastX: 0, stuck: 0 };
}

const rnd = (n: number) => Math.floor(Math.random() * n);

/** Mean height of the cake's top surface over a stretch of columns (smaller = higher). */
function surfaceY(g: Grid, x0: number, x1: number): number {
  let sum = 0;
  let n = 0;
  for (let x = Math.max(0, x0); x <= Math.min(g.w - 1, x1); x += 4) {
    let y = 0;
    while (y < g.h && !g.solid(x, y)) y++;
    sum += y;
    n++;
  }
  return n ? sum / n : g.h;
}

/** MOVE: wander with purpose, hop when blocked, climb out of the tea. */
export function botInput(b: BotBrain, t: Tank, tick: number, teaRowNext: number, g?: Grid): number {
  const row = Math.floor(t.y / 256);
  const col = Math.floor(t.x / 256);
  const wet = row >= teaRowNext - 14;
  if (tick >= b.until) {
    if (wet && g) {
      // The tea is coming: head for whichever side of the cake stands taller.
      const l = surfaceY(g, col - 90, col - 10);
      const r = surfaceY(g, col + 10, col + 90);
      b.dir = l < r ? -1 : 1;
      b.until = tick + 60 + rnd(40);
    } else {
      b.dir = [-1, 1, 1, -1, 0][rnd(5)];
      b.until = tick + 20 + rnd(50);
    }
  }
  let bits = b.dir < 0 ? IN_LEFT : b.dir > 0 ? IN_RIGHT : 0;
  if (b.dir !== 0 && Math.abs(t.x - b.lastX) < 8) b.stuck++;
  else b.stuck = 0;
  b.lastX = t.x;
  if (b.stuck > 2 && t.grounded) bits |= IN_JUMP;
  if (b.stuck > 14) bits |= IN_DIG;
  if (b.stuck > 40) b.until = 0;
  // feet wet next round? keep hopping
  if (wet && t.grounded && rnd(4) === 0) bits |= IN_JUMP;
  return bits;
}

function aimAt(g: Grid, me: Tank, tx: number, ty: number, weapon: string): Plan | null {
  const w = WEAPON_BY_ID[weapon];
  const cx = me.x;
  const cy = me.y - (POT.ht >> 1);
  let best: Plan | null = null;
  let bestD = Infinity;
  const right = tx >= me.x;
  for (let a = 150; a <= 850; a += 50) {
    const angle = right ? a : 1800 - a;
    for (let power = 250; power <= 1000; power += 50) {
      const [vx, vy] = launchVel(angle, power, w.speed);
      const [mx, my] = launchVel(angle, 1000, 820);
      const hit = traceShell(g, cx + mx, cy + my, vx, vy);
      if (!hit.hit) continue;
      const d = Math.abs(hit.x - tx) + Math.abs(hit.y - ty);
      // don't blow ourselves up
      if (Math.abs(hit.x - cx) + Math.abs(hit.y - cy) < w.radius * 2) continue;
      if (d < bestD) {
        bestD = d;
        best = { w: weapon, angle, power };
      }
    }
  }
  if (!best) return null;
  // Bots are fodder, not snipers: fuzz the aim.
  best.angle = (best.angle + rnd(51) - 25 + 3600) % 3600;
  best.power = Math.max(150, Math.min(1000, best.power + rnd(61) - 30));
  return best;
}

/**
 * Damage this pair would do to its own pot, run through the real sim in a
 * world where nobody else acts (the same question the player's planning
 * preview answers). Tea is left out: that is a MOVE problem, not an aim one.
 */
export function selfHarm(g: Grid, me: Tank, tanks: Tank[], pair: PlanPair): number {
  if (!pair[0] && !pair[1]) return 0;
  const copies = tanks.map((t) => unpackTank(packTank(t)));
  const sim = new ResolveSim(g.clone(), copies, { [me.id]: pair }, g.h);
  let hurt = 0;
  while (!sim.done && sim.tick < 900) sim.step();
  for (const e of sim.events) if (e.k === "dmg" && e.v === me.id) hurt += e.n ?? 0;
  return hurt;
}

export function botPlan(g: Grid, me: Tank, tanks: Tank[], ammo: Record<string, number>): PlanPair {
  const foes = tanks.filter((t) => t.alive && t.id !== me.id);
  if (!foes.length) return [null, null];
  foes.sort((a, b) => Math.abs(a.x - me.x) - Math.abs(b.x - me.x));
  const draft = (): PlanPair => {
    const left = { ...ammo };
    const pick = (): Plan | null => {
      const roll = rnd(100);
      if (roll < 14) return { w: "steam", angle: rnd(2) ? 500 + rnd(300) : 1000 + rnd(300), power: 600 + rnd(400) };
      if (roll < 22 && left.cloche > 0 && me.hp < 70) {
        left.cloche--;
        return { w: "cloche", angle: 900, power: 500 };
      }
      const target = foes[rnd(3) === 0 ? rnd(foes.length) : 0];
      const options = ["sugar", "sugar", "sugar", "jawbreaker", "sprinkles", "corkscrew", "dough"].filter((id) => left[id] !== 0);
      const weapon = options[rnd(options.length)];
      const plan = aimAt(g, me, target.x, target.y - (POT.ht >> 1), weapon);
      if (plan && left[weapon] > 0) left[weapon]--;
      return plan;
    };
    return [pick(), rnd(5) === 0 ? null : pick()];
  };
  // A player would see the self-damage warning in the preview and re-aim;
  // bots do the same, a few times, then settle for the least painful idea.
  let best: PlanPair = [null, null];
  let bestHurt = Infinity;
  for (let attempt = 0; attempt < 5 && bestHurt > 0; attempt++) {
    const pair = draft();
    const hurt = selfHarm(g, me, tanks, pair);
    if (hurt < bestHurt) {
      best = pair;
      bestHurt = hurt;
    }
  }
  if (bestHurt > 0) {
    // Still hurts: keep whichever single lump does not.
    for (const solo of [[best[0], null], [null, best[1]]] as PlanPair[]) {
      if ((solo[0] || solo[1]) && selfHarm(g, me, tanks, solo) === 0) return solo;
    }
  }
  return best;
}
