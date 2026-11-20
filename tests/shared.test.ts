import { describe, expect, it } from "vitest";
import { AIR, CANDY, DOUGH, MATERIALS, PLATE, SPONGE } from "../shared/src/content/materials";
import { POT } from "../shared/src/content/tanks";
import { buildTimeline } from "../shared/src/director";
import { addBlob, carveCircle, findLoose, Grid, WORLD_H } from "../shared/src/grid";
import { initialAmmo, MAX_ROUNDS, TEA_FROM_ROUND, teaRowFor } from "../shared/src/protocol";
import { botPlan, selfHarm } from "../server/src/bots";
import { mulberry32 } from "../shared/src/prng";
import { PlanPair, ResolveSim, runResolve, sanitizePlan, worldHash } from "../shared/src/sim";
import { applyDigEdit, boxFree, cloneTank, IN_DIG, IN_JUMP, IN_RIGHT, makeTank, stepTank, Tank, tankDig } from "../shared/src/tank";
import { findSpawns, generateTerrain } from "../shared/src/terrain";

const C = 256;

function flatWorld(): Grid {
  const g = new Grid(120, 80);
  for (let y = 50; y < 80; y++) for (let x = 0; x < 120; x++) g.cells[y * 120 + x] = y >= 76 ? PLATE : SPONGE;
  return g;
}

function spawnPots(g: Grid, seed: number, n: number): Tank[] {
  return findSpawns(g, n, mulberry32(seed)).map((p, i) => makeTank(i, p.x, p.y));
}

describe("prng", () => {
  it("mulberry32 is stable", () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    const seq = Array.from({ length: 50 }, () => a.next());
    expect(Array.from({ length: 50 }, () => b.next())).toEqual(seq);
    expect(new Set(seq).size).toBe(50);
    expect(seq.every((v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff)).toBe(true);
    for (let i = 0; i < 200; i++) expect(a.int(3, 9)).toBeGreaterThanOrEqual(3);
  });
});

describe("terrain", () => {
  it("same seed gives identical grids, different seeds differ", () => {
    const a = generateTerrain(1234);
    const b = generateTerrain(1234);
    const c = generateTerrain(1235);
    expect(a.hash()).toBe(b.hash());
    expect(a.hash()).not.toBe(c.hash());
  });

  it("same seed + same edits gives identical grids", () => {
    const run = () => {
      const g = generateTerrain(99);
      const r = mulberry32(7);
      for (let i = 0; i < 60; i++) {
        const x = r.int(0, g.w * C);
        const y = r.int(60 * C, g.h * C);
        if (i % 3 === 0) addBlob(g, x, y, r.int(2, 9) * C, DOUGH, []);
        else if (i % 3 === 1) carveCircle(g, x, y, r.int(2, 12) * C);
        else applyDigEdit(g, { x, y, r: POT.digRadius, b: r.int(1, 200) });
      }
      runResolve(g, [], {}, g.h); // let loose chunks settle
      return g;
    };
    const a = run();
    const b = run();
    expect(a.hash()).toBe(b.hash());
    expect(Array.from(a.toRLE())).toEqual(Array.from(b.toRLE()));
  });

  it("is a real 2D world: caves, overhangs and floating islands exist", () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const g = generateTerrain(seed);
      let multi = 0; // columns with more than one separate solid span
      let caveCells = 0; // air with solid somewhere above it
      for (let x = 0; x < g.w; x++) {
        let spans = 0;
        let seenSolid = false;
        for (let y = 0; y < g.h; y++) {
          const s = g.cells[y * g.w + x] !== AIR;
          if (s && (y === 0 || g.cells[(y - 1) * g.w + x] === AIR)) spans++;
          if (s) seenSolid = true;
          else if (seenSolid) caveCells++;
        }
        if (spans > 1) multi++;
      }
      expect(multi, `seed ${seed} multi-span columns`).toBeGreaterThan(g.w / 4);
      expect(caveCells, `seed ${seed} cave cells`).toBeGreaterThan(800);
      expect(findLoose(g).length, `seed ${seed} starts settled`).toBe(0);
    }
  });

  it("RLE round-trips", () => {
    const g = generateTerrain(42);
    const h = new Grid();
    h.loadRLE(g.toRLE());
    expect(h.hash()).toBe(g.hash());
  });

  it("explosions carve holes that join into tunnels a pot can travel through", () => {
    const g = flatWorld();
    // a row of overlapping blasts well below the surface = a tunnel with a roof
    for (let x = 20; x <= 100; x += 6) carveCircle(g, x * C, 62 * C, 5 * C);
    expect(g.get(60, 62)).toBe(AIR); // hole
    expect(g.get(60, 52)).toBe(SPONGE); // ground still above it
    expect(g.get(60, 72)).toBe(SPONGE); // and below
    const t = makeTank(0, 22 * C, 62 * C);
    for (let i = 0; i < 60; i++) stepTank(g, t, 0, false); // settle on the tunnel floor
    const startX = t.x;
    for (let i = 0; i < 600; i++) stepTank(g, t, IN_RIGHT, false);
    expect(t.x - startX).toBeGreaterThan(60 * C);
    expect(Math.floor(t.y / C)).toBeGreaterThan(55); // still underground
  });

  it("toughness and indestructibility are respected", () => {
    const g = new Grid(40, 40);
    g.cells.fill(CANDY);
    expect(carveCircle(g, 20 * C, 20 * C, 10 * C)).toBe(0);
    expect(MATERIALS[CANDY].anchor).toBe(true);
  });

  it("unsupported terrain falls, supported terrain does not", () => {
    const g = flatWorld();
    // a slab floating in the sky, and one glued to a candy cell
    for (let y = 10; y < 14; y++) for (let x = 20; x < 40; x++) g.set(x, y, SPONGE);
    for (let y = 10; y < 14; y++) for (let x = 60; x < 80; x++) g.set(x, y, SPONGE);
    g.set(70, 12, CANDY);
    const ev = runResolve(g, [], {}, g.h);
    expect(g.get(30, 10)).toBe(AIR);
    expect(g.get(30, 49)).toBe(SPONGE); // landed on the ground
    expect(g.get(70, 10)).toBe(SPONGE); // anchored one stayed
    expect(ev.some((e) => e.k === "thud")).toBe(true);
    expect(findLoose(g).length).toBe(0);
  });

  it("a pot under a collapse is hurt and buried, never embedded", () => {
    const g = flatWorld();
    for (let y = 8; y < 20; y++) for (let x = 40; x < 70; x++) g.set(x, y, SPONGE);
    const t = makeTank(0, 55 * C, 50 * C);
    runResolve(g, [t], {}, g.h);
    expect(t.hp).toBeLessThan(POT.hp);
    expect(t.alive).toBe(true);
    expect(boxFree(g, t.x, t.y)).toBe(true);
    expect(g.get(55, 44)).not.toBe(AIR); // cake above its head
  });
});

describe("pots", () => {
  it("climb gentle slopes, are stopped by walls, fall, and stand under ceilings", () => {
    const g = flatWorld();
    // staircase 1 cell per 2 cells: climbable
    for (let i = 0; i < 10; i++) for (let y = 49 - i; y < 50; y++) for (let x = 40 + i * 2; x < 90; x++) g.set(x, y, SPONGE);
    // sheer wall further right
    for (let y = 20; y < 50; y++) for (let x = 90; x < 94; x++) g.set(x, y, SPONGE);
    const t = makeTank(0, 20 * C, 50 * C);
    for (let i = 0; i < 400; i++) stepTank(g, t, IN_RIGHT, false);
    expect(Math.floor(t.y / C)).toBeLessThanOrEqual(41); // climbed the stairs
    for (let i = 0; i < 600; i++) stepTank(g, t, IN_RIGHT, false);
    expect(t.x).toBeLessThan(90 * C); // wall stopped it
    expect(t.grounded).toBe(true);
    // low ceiling: jumping must not pass through it
    const u = makeTank(1, 10 * C, 50 * C);
    for (let x = 4; x < 16; x++) g.set(x, 44, CANDY);
    for (let i = 0; i < 40; i++) stepTank(g, u, IN_JUMP, false);
    expect(u.y - POT.ht).toBeGreaterThanOrEqual(45 * C);
  });

  it("digging tunnels through cake and costs energy", () => {
    const g = flatWorld();
    for (let y = 30; y < 50; y++) for (let x = 40; x < 100; x++) g.set(x, y, SPONGE);
    const t = makeTank(0, 30 * C, 50 * C);
    for (let i = 0; i < 300; i++) {
      stepTank(g, t, IN_RIGHT | IN_DIG, false);
      stepTank(g, t, IN_RIGHT | IN_DIG, false);
      tankDig(g, t, IN_RIGHT | IN_DIG);
    }
    expect(t.x).toBeGreaterThan(45 * C);
    expect(t.dig).toBeLessThan(POT.digEnergy);
    expect(g.get(60, 32)).toBe(SPONGE); // roof intact: it is a tunnel
  });
});

describe("resolve", () => {
  const plansFor = (pots: Tank[]): Record<number, PlanPair> => {
    const weapons = ["sugar", "jawbreaker", "sprinkles", "corkscrew", "dough", "steam", "cloche"];
    const r = mulberry32(555);
    const out: Record<number, PlanPair> = {};
    for (const t of pots) {
      out[t.id] = [0, 1].map(() => ({
        w: weapons[r.int(0, weapons.length - 1)],
        angle: r.int(200, 1600),
        power: r.int(300, 1000),
      })) as PlanPair;
    }
    return out;
  };

  it("same inputs give the same outcome, event for event", () => {
    const run = () => {
      const g = generateTerrain(2024);
      const pots = spawnPots(g, 2024, 8);
      const ev = runResolve(g, pots, plansFor(pots), 190);
      return { h: worldHash(g, pots), ev: JSON.stringify(ev) };
    };
    const a = run();
    const b = run();
    expect(a.h).toBe(b.h);
    expect(a.ev).toBe(b.ev);
    expect(a.ev.length).toBeGreaterThan(200);
  });

  it("stepping tick by tick matches running to the end (replay == authority)", () => {
    const g1 = generateTerrain(31337);
    const p1 = spawnPots(g1, 31337, 6);
    const plans = plansFor(p1);
    const g2 = g1.clone();
    const p2 = p1.map(cloneTank);
    runResolve(g1, p1, plans, 200);
    const sim = new ResolveSim(g2, p2, plans, 200);
    let guard = 0;
    while (!sim.done && guard++ < 5000) sim.step();
    expect(worldHash(g2, p2)).toBe(worldHash(g1, p1));
    expect(findLoose(g2).length).toBe(0);
    for (const t of p2) if (t.alive) expect(boxFree(g2, t.x, t.y)).toBe(true);
  });

  it("always terminates and leaves a settled world over many random rounds", () => {
    for (let seed = 1; seed <= 12; seed++) {
      const g = generateTerrain(seed * 7919);
      const pots = spawnPots(g, seed, 8);
      const r = mulberry32(seed);
      for (let round = 0; round < 4; round++) {
        const plans: Record<number, PlanPair> = {};
        for (const t of pots) {
          plans[t.id] = [0, 1].map(() =>
            sanitizePlan({ w: ["sugar", "jawbreaker", "sprinkles", "corkscrew", "dough", "steam", "cloche"][r.int(0, 6)], angle: r.int(0, 3599), power: r.int(0, 1000) }),
          ) as PlanPair;
        }
        const sim = new ResolveSim(g, pots, plans, 200 - round * 10);
        const ev = sim.runToEnd();
        expect(ev[ev.length - 1].k).toBe("end");
        expect(findLoose(g).length).toBe(0);
        for (const t of pots) if (t.alive) expect(boxFree(g, t.x, t.y), `seed ${seed} pot ${t.id}`).toBe(true);
        const tl = buildTimeline(ev, 8);
        expect(tl.totalMs).toBeGreaterThan(2000);
        expect(tl.totalMs).toBeLessThan(60000);
      }
    }
  });

  it("a sugar cube hurts, a cloche returns it to sender, a hop dodges it", () => {
    const setup = () => {
      const g = flatWorld();
      return { g, a: makeTank(0, 30 * C, 50 * C), b: makeTank(1, 90 * C, 50 * C) };
    };
    // find a shot from a that hits b
    let shot: { angle: number; power: number } | null = null;
    for (let power = 400; power <= 1000 && !shot; power += 10) {
      const { g, a, b } = setup();
      runResolve(g, [a, b], { 0: [{ w: "sugar", angle: 450, power }, null] }, g.h);
      if (b.hp <= POT.hp - 30) shot = { angle: 450, power };
    }
    expect(shot).not.toBeNull();
    {
      const { g, a, b } = setup();
      const ev = runResolve(g, [a, b], { 0: [{ w: "sugar", ...shot! }, null], 1: [{ w: "cloche", angle: 0, power: 500 }, null] }, g.h);
      expect(b.hp).toBe(POT.hp);
      expect(ev.some((e) => e.k === "reflect")).toBe(true);
    }
    {
      const { g, a, b } = setup();
      runResolve(g, [a, b], { 0: [{ w: "sugar", ...shot! }, null], 1: [{ w: "steam", angle: 300, power: 1000 }, null] }, g.h);
      expect(b.hp).toBe(POT.hp);
      expect(b.x).toBeGreaterThan(100 * C);
    }
  });

  it("mirrored shots clash in mid-air; dough balls that clash make a blob that falls", () => {
    const g = flatWorld();
    const a = makeTank(0, 30 * C, 50 * C);
    const b = makeTank(1, 90 * C, 50 * C);
    const ev = runResolve(g, [a, b], { 0: [{ w: "dough", angle: 450, power: 800 }, null], 1: [{ w: "dough", angle: 1350, power: 800 }, null] }, g.h);
    expect(ev.some((e) => e.k === "clash")).toBe(true);
    expect(ev.filter((e) => e.k === "build").length).toBe(2);
    expect(ev.some((e) => e.k === "thud")).toBe(true);
  });

  it("a corkscrew bores a tunnel; dough buries without embedding", () => {
    const g = flatWorld();
    for (let y = 20; y < 50; y++) for (let x = 55; x < 75; x++) g.set(x, y, SPONGE);
    const a = makeTank(0, 30 * C, 50 * C);
    const before = g.cells.filter((c) => c !== AIR).length;
    const ev = runResolve(g, [a], { 0: [{ w: "corkscrew", angle: 200, power: 900 }, null] }, g.h);
    expect(ev.some((e) => e.k === "drill")).toBe(true);
    expect(before - g.cells.filter((c) => c !== AIR).length).toBeGreaterThan(80);

    const g2 = flatWorld();
    const p = makeTank(0, 30 * C, 50 * C);
    const q = makeTank(1, 60 * C, 50 * C);
    for (let power = 300; power <= 1000; power += 20) {
      const gg = g2.clone();
      const pp = cloneTank(p);
      const qq = cloneTank(q);
      const e2 = runResolve(gg, [pp, qq], { 0: [{ w: "dough", angle: 450, power }, null] }, gg.h);
      const b = e2.find((e) => e.k === "build");
      if (b && Math.abs(b.x! - qq.x) < 2 * C) {
        expect(boxFree(gg, qq.x, qq.y)).toBe(true);
        expect(qq.hp).toBe(POT.hp);
        return;
      }
    }
    throw new Error("no dough shot landed on the target");
  });

  it("the dead do not pour their second lump", () => {
    const g = flatWorld();
    const a = makeTank(0, 30 * C, 50 * C);
    a.hp = 1;
    const b = makeTank(1, 34 * C, 50 * C);
    const ev = runResolve(g, [a, b], { 0: [null, { w: "sugar", angle: 900, power: 500 }], 1: [{ w: "sugar", angle: 1800, power: 300 }, null] }, g.h);
    expect(a.alive).toBe(false);
    expect(ev.some((e) => e.k === "fizzle" && e.a === 0)).toBe(true);
    expect(ev.some((e) => e.k === "death" && e.v === 0)).toBe(true);
  });

  it("rejects malformed plans", () => {
    expect(sanitizePlan(null)).toBeNull();
    expect(sanitizePlan({ w: "bomblet", angle: 1, power: 1 })).toBeNull();
    expect(sanitizePlan({ w: "nuke" })).toBeNull();
    expect(sanitizePlan({ w: "sugar", angle: 99999, power: -5 })).toEqual({ w: "sugar", angle: 3599, power: 150 });
    expect(sanitizePlan({ w: "sugar", angle: NaN, power: "x" })).toEqual({ w: "sugar", angle: 900, power: 600 });
  });
});

describe("pacing", () => {
  it("the tea arrives on schedule, only ever rises, and leaves a cake to fight on", () => {
    expect(teaRowFor(1)).toBe(WORLD_H);
    expect(teaRowFor(TEA_FROM_ROUND - 1)).toBe(WORLD_H);
    expect(teaRowFor(TEA_FROM_ROUND)).toBeLessThan(WORLD_H);
    for (let r = 1; r < MAX_ROUNDS + 4; r++) expect(teaRowFor(r + 1)).toBeLessThanOrEqual(teaRowFor(r));
    expect(teaRowFor(MAX_ROUNDS)).toBeGreaterThanOrEqual(60);
  });
});

describe("bots", () => {
  it("re-aim instead of queueing lumps that would hurt themselves", () => {
    let hurtPairs = 0;
    let plans = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const g = generateTerrain(seed * 7919);
      const pots = spawnPots(g, seed, 4);
      for (const me of pots) {
        const pair = botPlan(g, me, pots, initialAmmo());
        plans++;
        if (selfHarm(g, me, pots, pair) > 0) hurtPairs++;
      }
    }
    // A pot boxed into a pocket may have no clean shot at all; that should be rare.
    expect(hurtPairs).toBeLessThanOrEqual(Math.ceil(plans * 0.1));
  });
});
