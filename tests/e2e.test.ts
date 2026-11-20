/**
 * End-to-end: a real server on a real port, real colyseus.js clients.
 * Each client mirrors the world the way the game client does (seed + dig
 * edits + replaying the resolve) and proves it stays in step with the server.
 */
import { Client, Room } from "colyseus.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Grid } from "../shared/src/grid";
import {
  C_BOT, C_INPUT, C_PLAN, C_READY, EditMsg, OverMsg, PhaseMsg, ResolveMsg, ROOM_NAME, S_EDIT, S_OVER, S_PHASE, S_RESOLVE, S_SNAP,
  S_SYNC, S_YOU, SyncMsg, YouMsg,
} from "../shared/src/protocol";
import { runResolve, worldHash } from "../shared/src/sim";
import { applyDigEdit, unpackTank } from "../shared/src/tank";
import { generateTerrain } from "../shared/src/terrain";

process.env.TEAPOT_TEST = "1";

let server: { port: number; stop(): Promise<void> };

beforeAll(async () => {
  const { startServer } = await import("../server/src/app");
  server = await startServer(0);
});
afterAll(async () => {
  await server?.stop();
});

class Sim {
  room!: Room;
  grid = new Grid(1, 1);
  phases: string[] = [];
  phase = "LOBBY";
  you?: YouMsg;
  over?: OverMsg;
  resolves = 0;
  mismatches: string[] = [];
  edits = 0;
  snaps = 0;
  syncs: SyncMsg[] = [];
  seq = 0;
  private timer?: ReturnType<typeof setInterval>;
  /** what this fake player does */
  constructor(public name: string, private style: { plan: boolean; lock: boolean } = { plan: true, lock: true }) {}

  async join(instanceId: string, extra: Record<string, unknown> = {}): Promise<this> {
    const client = new Client(`ws://localhost:${server.port}`);
    this.room = await client.joinOrCreate(ROOM_NAME, { name: this.name, instanceId, ...extra });
    const r = this.room;
    r.onMessage(S_YOU, (m: YouMsg) => (this.you = m));
    r.onMessage(S_SYNC, (m: SyncMsg) => {
      this.syncs.push(m);
      if (m.rle) {
        this.grid = new Grid(360, 200);
        this.grid.loadRLE(m.rle);
      } else this.grid = generateTerrain(m.seed);
      if (this.grid.hash() !== m.hash) this.mismatches.push(`sync hash r${m.round}`);
    });
    r.onMessage(S_EDIT, (m: EditMsg) => {
      this.edits++;
      applyDigEdit(this.grid, m.e);
    });
    r.onMessage(S_SNAP, () => this.snaps++);
    r.onMessage(S_OVER, (m: OverMsg) => (this.over = m));
    r.onMessage(S_RESOLVE, (m: ResolveMsg) => {
      this.resolves++;
      if (this.grid.hash() !== m.pre) this.mismatches.push(`pre hash r${m.round}`);
      const tanks = m.tanks.map(unpackTank);
      runResolve(this.grid, tanks, m.plans, m.teaRow);
      if (worldHash(this.grid, tanks) !== m.post) this.mismatches.push(`post hash r${m.round}`);
    });
    r.onMessage(S_PHASE, (m: PhaseMsg) => {
      this.phase = m.phase;
      if (this.phases[this.phases.length - 1] !== m.phase) this.phases.push(m.phase);
      clearInterval(this.timer);
      if (m.phase === "MOVE") {
        // mash the controls, including the dig key, like a real player
        this.timer = setInterval(() => r.send(C_INPUT, [++this.seq, [1, 2, 9, 10, 6, 42, 5][(this.seq >> 3) % 7]]), 16);
      }
      if (m.phase === "PLAN" && this.style.plan) {
        const plans = [
          { w: "sugar", angle: 300 + ((this.seq * 37) % 1200), power: 700 },
          { w: "corkscrew", angle: 2700, power: 600 },
        ];
        r.send(C_PLAN, { plans, lock: this.style.lock });
      }
    });
    return this;
  }

  until(pred: () => boolean, ms = 30000, what = "condition"): Promise<void> {
    return new Promise((res, rej) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (pred()) {
          clearInterval(iv);
          res();
        } else if (Date.now() - t0 > ms) {
          clearInterval(iv);
          rej(new Error(`${this.name}: timed out waiting for ${what}; phases=${this.phases.join(">")}`));
        }
      }, 10);
    });
  }

  leave(): Promise<unknown> {
    clearInterval(this.timer);
    return this.room.leave(true);
  }
}

describe("end to end", () => {
  it("plays a full match with two clients and a bot, in lockstep, back to the lobby", async () => {
    const opts = { fast: 0.04, hp: 100, rounds: 3 };
    const a = await new Sim("Ann").join("t1", opts);
    const b = await new Sim("  <b>Bob</b>\u0007  ").join("t1", opts);
    expect(a.room.roomId).toBe(b.room.roomId);
    await a.until(() => a.room.state.players?.size === 2, 3000, "roster");
    const names = [...a.room.state.players.values()].map((p: any) => p.name);
    expect(names).toContain("bBobb"); // markup stripped server-side

    a.room.send(C_BOT, 1);
    b.room.send(C_BOT, 1); // not the host: ignored
    await a.until(() => a.room.state.players.size === 3, 3000, "bot");
    await new Promise((r) => setTimeout(r, 150));
    expect(a.room.state.players.size).toBe(3);

    a.room.send(C_READY, true);
    await new Promise((r) => setTimeout(r, 100));
    expect(a.phase).toBe("LOBBY"); // not everyone is ready
    b.room.send(C_READY, true);

    await a.until(() => a.phase === "GAME_OVER", 40000, "game over");
    expect(a.over).toBeTruthy();
    expect(a.over!.rows.length).toBe(3);
    await a.until(() => a.phase === "LOBBY", 10000, "lobby again");
    await b.until(() => b.phase === "LOBBY", 10000, "lobby again");

    for (const c of [a, b]) {
      expect(c.mismatches).toEqual([]);
      expect(c.resolves).toBeGreaterThanOrEqual(1);
      expect(c.snaps).toBeGreaterThan(5);
      const s = c.phases.join(">");
      expect(s).toContain("COUNTDOWN>MOVE>PLAN>RESOLVE>AFTERMATH");
      expect(s.endsWith("GAME_OVER>LOBBY")).toBe(true);
    }
    expect(a.edits).toBeGreaterThan(0); // digging really was replicated
    expect(a.you!.ammo.corkscrew).toBeLessThan(3); // ammo was spent server-side
    await a.leave();
    await b.leave();
  });

  it("survives silence, late joiners and people leaving in any phase", async () => {
    const opts = { fast: 0.04, hp: 100, rounds: 4 };
    const a = await new Sim("Ann", { plan: false, lock: false }).join("t2", opts); // never plans
    const b = await new Sim("Bob").join("t2", opts);
    a.room.send(C_READY, true);
    b.room.send(C_READY, true);
    await a.until(() => a.phase === "PLAN", 10000, "first plan");

    // A late joiner gets the dug-up world as a snapshot and watches.
    const c = await new Sim("Cat").join("t2", opts);
    await c.until(() => c.syncs.length > 0, 3000, "late sync");
    expect(c.syncs[0].rle).toBeTruthy();
    expect(c.mismatches).toEqual([]);

    // ...and gets a pot in the next round.
    await c.until(() => c.phase === "MOVE", 20000, "next round");
    await c.until(() => (c.room.state.players.get(c.room.sessionId) as any)?.inMatch === true, 3000, "pot");

    // Bob walks out mid-PLAN; the round must still resolve.
    await a.until(() => a.phase === "PLAN", 10000, "second plan");
    await b.leave();
    await a.until(() => a.phase === "RESOLVE", 10000, "resolve without Bob");

    await a.until(() => a.phase === "LOBBY" && a.phases.includes("GAME_OVER"), 40000, "finish");
    expect(a.mismatches).toEqual([]);
    expect(c.mismatches).toEqual([]);
    expect(c.resolves).toBeGreaterThanOrEqual(1);
    await a.leave();
    await c.leave();
  });

  it("rejects out-of-phase and malformed input without falling over", async () => {
    const a = await new Sim("Mallory", { plan: false, lock: false }).join("t3", { fast: 0.04, rounds: 1 });
    const r = a.room;
    r.send(C_PLAN, { plans: [{ w: "sugar", angle: 1, power: 1 }], lock: true }); // lobby: ignored
    r.send(C_INPUT, [1, 1]);
    r.send(C_INPUT, "nope");
    r.send(C_BOT, 99);
    r.send("made-up", { x: 1 });
    r.send(C_READY, true);
    await a.until(() => a.phase === "PLAN", 10000, "plan");
    r.send(C_PLAN, null);
    r.send(C_PLAN, { plans: "x" });
    r.send(C_PLAN, { plans: [{ w: "nuke", angle: 1e9, power: -5 }, { w: "cloche", angle: NaN, power: "9" }], lock: true });
    await a.until(() => a.phase === "LOBBY" && a.phases.includes("GAME_OVER"), 30000, "finish");
    expect(a.mismatches).toEqual([]);
    await a.leave();
  });
});
