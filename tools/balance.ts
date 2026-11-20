/**
 * Headless balance harness: plays whole bot matches with the real terrain,
 * pot physics, bot brains, resolve sim and director (no network), and prints
 * the numbers that decide pacing.
 *
 *   npx tsx tools/balance.ts [matches=60] [pots=4]
 */
import { POT } from "../shared/src/content/tanks";
import { buildTimeline } from "../shared/src/director";
import { mulberry32 } from "../shared/src/prng";
import { initialAmmo, MAX_ROUNDS, TIMING, teaRowFor } from "../shared/src/protocol";
import { PlanPair, runResolve, SimEvent } from "../shared/src/sim";
import { ensureFree, makeTank, packTank, stepTank, tankDig, unpackTank } from "../shared/src/tank";
import { findSpawns, generateTerrain } from "../shared/src/terrain";
import { botInput, botPlan, newBrain } from "../server/src/bots";

const MATCHES = Number(process.argv[2] ?? 60);
const POTS = Number(process.argv[3] ?? 4);

const rounds: number[] = [];
const pourMs: number[] = [];
const quietPours: number[] = []; // pours with no damage at all
let draws = 0;
let outlasted = 0;
let byRounds = 0;
const deathBy: Record<string, number> = {};
const dmgBy: Record<string, number> = {};
let selfDmg = 0;
let totalDmg = 0;
let firstKillRound: number[] = [];

for (let m = 0; m < MATCHES; m++) {
  const seed = (Math.random() * 2 ** 32) >>> 0;
  const grid = generateTerrain(seed);
  const spawns = findSpawns(grid, POTS, mulberry32(seed ^ 0x9e3779b9));
  const tanks = spawns.map((s, i) => {
    const t = makeTank(i, s.x, s.y);
    t.facing = s.x < (grid.w * 256) / 2 ? 1 : -1;
    return t;
  });
  const brains = tanks.map(() => newBrain());
  const ammo = tanks.map(() => initialAmmo());
  let round = 0;
  let firstKill = 0;
  while (true) {
    round++;
    for (const t of tanks) {
      t.dig = POT.digEnergy;
      t.vx = t.vy = 0;
      ensureFree(grid, t);
    }
    const nextTea = teaRowFor(round + 1);
    for (let tick = 1; tick <= (TIMING.MOVE / 1000) * 30; tick++) {
      for (const t of tanks) {
        if (!t.alive) continue;
        const bits = botInput(brains[t.id], t, tick, nextTea, grid);
        stepTank(grid, t, bits, false);
        stepTank(grid, t, bits, false);
        tankDig(grid, t, bits);
      }
    }
    for (const t of tanks) Object.assign(t, unpackTank(packTank(t)));
    const plans: Record<number, PlanPair> = {};
    for (const t of tanks) if (t.alive) plans[t.id] = botPlan(grid, t, tanks, ammo[t.id]);
    const alive0 = tanks.filter((t) => t.alive).length;
    const events: SimEvent[] = runResolve(grid, tanks, plans, teaRowFor(round));
    const tl = buildTimeline(events, alive0);
    pourMs.push(tl.totalMs);
    let dmgThis = 0;
    for (const e of events) {
      if (e.k === "fire" && e.w && ammo[e.a!][e.w] > 0) ammo[e.a!][e.w]--;
      if (e.k === "dmg") {
        const n = e.n ?? 0;
        dmgThis += n;
        totalDmg += n;
        if (e.a === e.v) selfDmg += n;
        const key = e.c === "blast" ? `blast:${e.w}` : e.c!;
        dmgBy[key] = (dmgBy[key] ?? 0) + n;
      }
      if (e.k === "death") {
        const key = e.c === "blast" ? (e.a === e.v ? "own blast" : `blast:${e.w}`) : e.c!;
        deathBy[key] = (deathBy[key] ?? 0) + 1;
        if (!firstKill) firstKill = round;
      }
    }
    if (!dmgThis) quietPours.push(round);
    const alive = tanks.filter((t) => t.alive);
    if (alive.length <= 1 || round >= MAX_ROUNDS) {
      if (alive.length === 0) {
        // same tie-break as GameRoom.gameOver: latest shattering wins
        const ticks = events.filter((e) => e.k === "death").map((e) => e.t).sort((a, b) => b - a);
        if (ticks.length > 1 && ticks[0] > ticks[1]) outlasted++;
        else draws++;
      }
      if (alive.length > 1) byRounds++;
      break;
    }
  }
  rounds.push(round);
  firstKillRound.push(firstKill || round);
}

const stats = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  const avg = s.reduce((x, y) => x + y, 0) / s.length;
  return `avg ${avg.toFixed(1)}  p10 ${s[Math.floor(s.length * 0.1)]}  median ${s[Math.floor(s.length / 2)]}  p90 ${s[Math.floor(s.length * 0.9)]}  max ${s[s.length - 1]}`;
};
const pct = (n: number, d: number) => `${((100 * n) / Math.max(1, d)).toFixed(0)}%`;
const roundMs = TIMING.MOVE + TIMING.PLAN + TIMING.AFTERMATH;
const avgPour = pourMs.reduce((a, b) => a + b, 0) / pourMs.length;
const avgRounds = rounds.reduce((a, b) => a + b, 0) / rounds.length;

console.log(`${MATCHES} matches, ${POTS} bot pots each`);
console.log(`rounds per match     ${stats(rounds)}`);
console.log(`first kill in round  ${stats(firstKillRound)}`);
console.log(`pour length (ms)     ${stats(pourMs)}`);
console.log(`quiet pours          ${pct(quietPours.length, pourMs.length)} of pours dealt no damage`);
console.log(`endings              last-pot ${pct(MATCHES - draws - byRounds - outlasted, MATCHES)}, outlasted ${pct(outlasted, MATCHES)}, draw ${pct(draws, MATCHES)}, round cap ${pct(byRounds, MATCHES)}`);
console.log(`est. match length    ${((avgRounds * (roundMs + avgPour)) / 60000).toFixed(1)} min (full Steep timer; locking early shortens it)`);
console.log(`self damage          ${pct(selfDmg, totalDmg)} of all damage`);
console.log("damage by source    ", Object.entries(dmgBy).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${pct(v, totalDmg)}`).join(", "));
console.log("deaths by cause     ", Object.entries(deathBy).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", "));
