/**
 * The authoritative room. Owns the terrain, the pots and the phase machine:
 *
 *   LOBBY -> COUNTDOWN -> [ MOVE -> PLAN -> RESOLVE -> AFTERMATH ]* -> GAME_OVER -> LOBBY
 *
 * Every phase is driven by a timer, so nobody leaving (or going silent) at
 * any moment can stall the table. Clients only ever send intent: a ready
 * flag, MOVE input bits, and a plan. All of it is validated here.
 */
import { Client, Delayed, Room } from "@colyseus/core";
import { POT } from "../../shared/src/content/tanks";
import { SELECTABLE, WEAPON_BY_ID } from "../../shared/src/content/weapons";
import { buildTimeline } from "../../shared/src/director";
import { Grid } from "../../shared/src/grid";
import { mulberry32 } from "../../shared/src/prng";
import {
  C_BOT, C_INPUT, C_PLAN, C_READY, C_SYNC, EditMsg, initialAmmo, MAX_CLIENTS, MAX_PLAYERS, MAX_ROUNDS, MOVE_HZ, OverMsg,
  Phase, PhaseMsg, RECONNECT_GRACE_S, ResolveMsg, S_EDIT, S_OVER, S_PHASE, S_RESOLVE, S_SNAP, S_SYNC, S_YOU, sanitizeName,
  SyncMsg, teaRowFor, TIMING, YouMsg,
} from "../../shared/src/protocol";
import { PlanPair, runResolve, sanitizePlan, SimEvent, worldHash } from "../../shared/src/sim";
import { ensureFree, IN_MASK, makeTank, packTank, stepTank, Tank, tankDig, unpackTank } from "../../shared/src/tank";
import { findSpawns, generateTerrain, perch } from "../../shared/src/terrain";
import { THEME } from "../../shared/src/theme";
import { botInput, botPlan, BotBrain, newBrain } from "./bots";
import { PlayerState, RoomState } from "./state";

interface Stats {
  dealt: number;
  taken: number;
  kills: number;
  self: number;
  dug: number;
}

interface Seat {
  id: string;
  st: PlayerState;
  client?: Client;
  brain?: BotBrain;
  tank?: Tank;
  queue: number[];
  lastBits: number;
  ack: number;
  plans: PlanPair;
  ammo: Record<string, number>;
  stats: Stats;
  order: number;
}

const zeroStats = (): Stats => ({ dealt: 0, taken: 0, kills: 0, self: 0, dug: 0 });

export class GameRoom extends Room<RoomState> {
  maxClients = MAX_CLIENTS;

  private seats = new Map<string, Seat>();
  private grid = new Grid(1, 1);
  private seed = 0;
  private phase: Phase = "LOBBY";
  private phaseEndsAt = 0;
  private timer?: Delayed;
  private moveTick = 0;
  private joinCounter = 0;
  private botCounter = 0;
  private startedWith = 0;
  private lastResolve?: ResolveMsg;
  /** pot id -> tick it shattered at, for the last Pour only (draw tie-break) */
  private deathTicks = new Map<number, number>();
  /** Test-only knobs (enabled by TEAPOT_TEST=1): time scale, hp, round cap. */
  private fast = 1;
  private hp = POT.hp;
  private rounds = MAX_ROUNDS;

  // ------------------------------------------------------------ lifecycle

  onCreate(options: Record<string, unknown>): void {
    this.setState(new RoomState());
    this.setPatchRate(100);
    if (process.env.TEAPOT_TEST === "1") {
      if (typeof options.fast === "number") this.fast = Math.max(0.01, Math.min(1, options.fast));
      if (typeof options.hp === "number") this.hp = Math.max(1, Math.min(POT.hp, options.hp | 0));
      if (typeof options.rounds === "number") this.rounds = Math.max(1, Math.min(MAX_ROUNDS, options.rounds | 0));
    }
    this.state.maxRounds = this.rounds;

    this.onMessage(C_READY, (c, v) => this.onReady(c, v));
    this.onMessage(C_BOT, (c, v) => this.onBot(c, v));
    this.onMessage(C_INPUT, (c, v) => this.onInput(c, v));
    this.onMessage(C_PLAN, (c, v) => this.onPlan(c, v));
    this.onMessage(C_SYNC, (c) => this.sendSync(c, true));
    this.onMessage("*", () => undefined); // ignore anything else

    this.setSimulationInterval(() => this.onMoveTick(), 1000 / MOVE_HZ);
  }

  onJoin(client: Client, options: Record<string, unknown>): void {
    const st = new PlayerState();
    st.name = this.uniqueName(sanitizeName(options?.name, "Guest"));
    st.slot = this.freeSlot();
    st.connected = true;
    const seat: Seat = {
      id: client.sessionId,
      st,
      client,
      queue: [],
      lastBits: 0,
      ack: 0,
      plans: [null, null],
      ammo: initialAmmo(),
      stats: zeroStats(),
      order: this.joinCounter++,
    };
    this.seats.set(seat.id, seat);
    this.state.players.set(seat.id, st);
    this.refreshHost();
    this.sendYou(seat);
    this.sendPhase(client);
    if (this.inMatch()) this.sendSync(client, true);
    if (this.phase === "COUNTDOWN") this.toLobby(); // a newcomer has not readied up
  }

  async onLeave(client: Client, consented: boolean): Promise<void> {
    const seat = this.seats.get(client.sessionId);
    if (!seat) return;
    seat.st.connected = false;
    seat.st.ready = false;
    seat.lastBits = 0;
    seat.queue.length = 0;
    this.refreshHost();
    this.afterRosterChange();
    if (!consented) {
      try {
        // Their pot stays on the table, idle, while we hold the seat.
        const back = await this.allowReconnection(client, RECONNECT_GRACE_S);
        seat.client = back;
        seat.st.connected = true;
        this.refreshHost();
        this.sendYou(seat);
        this.sendPhase(back);
        if (this.inMatch()) this.sendSync(back, true);
        return;
      } catch {
        /* grace window expired */
      }
    }
    this.removeSeat(seat);
  }

  private removeSeat(seat: Seat): void {
    if (seat.tank?.alive) {
      // Leaving mid-match forfeits: the pot is cleared away between phases.
      seat.tank.alive = false;
      seat.tank.hp = 0;
      if (this.phase !== "RESOLVE") {
        seat.st.alive = false;
        seat.st.hp = 0;
      }
    }
    seat.st.inMatch = false;
    this.seats.delete(seat.id);
    this.state.players.delete(seat.id);
    this.refreshHost();
    this.afterRosterChange();
  }

  /** Re-evaluate anything that waits on "everyone". */
  private afterRosterChange(): void {
    if (this.phase === "LOBBY" || this.phase === "COUNTDOWN") this.checkStart();
    if (this.phase === "PLAN") this.checkAllLocked();
    // No humans left at all: Colyseus disposes the room (and its timers) once
    // the last reconnection window closes. Bots do not keep a room alive.
    if (this.humans().length === 0 && this.phase !== "LOBBY") this.toLobby();
  }

  // -------------------------------------------------------------- helpers

  private humans(): Seat[] {
    return [...this.seats.values()].filter((s) => !s.brain);
  }

  private matchSeats(): Seat[] {
    return [...this.seats.values()].filter((s) => s.tank && s.st.inMatch).sort((a, b) => a.st.slot - b.st.slot);
  }

  private tanks(): Tank[] {
    return this.matchSeats().map((s) => s.tank!);
  }

  private inMatch(): boolean {
    return this.phase !== "LOBBY" && this.phase !== "COUNTDOWN";
  }

  private freeSlot(): number {
    const used = new Set([...this.seats.values()].map((s) => s.st.slot));
    for (let i = 0; i < MAX_PLAYERS; i++) if (!used.has(i)) return i;
    return -1;
  }

  private uniqueName(name: string): string {
    const taken = new Set([...this.seats.values()].map((s) => s.st.name));
    if (!taken.has(name)) return name;
    for (let i = 2; i < 99; i++) if (!taken.has(`${name} ${i}`)) return `${name} ${i}`;
    return name;
  }

  private refreshHost(): void {
    const host = this.humans()
      .filter((s) => s.st.connected)
      .sort((a, b) => a.order - b.order)[0];
    for (const s of this.seats.values()) s.st.host = s === host;
  }

  private ms(base: number): number {
    return Math.max(30, Math.round(base * this.fast));
  }

  private setPhase(phase: Phase, ms: number, then?: () => void): void {
    this.timer?.clear();
    this.phase = phase;
    this.state.phase = phase;
    this.phaseEndsAt = ms > 0 ? Date.now() + ms : 0;
    this.broadcast(S_PHASE, this.phaseMsg());
    if (ms > 0 && then) this.timer = this.clock.setTimeout(then, ms);
  }

  private phaseMsg(): PhaseMsg {
    const round = this.state.round;
    return {
      phase: this.phase,
      round,
      ms: this.phaseEndsAt ? Math.max(0, this.phaseEndsAt - Date.now()) : 0,
      teaRow: teaRowFor(round),
      nextTeaRow: teaRowFor(round + 1),
    };
  }

  private sendPhase(c: Client): void {
    c.send(S_PHASE, this.phaseMsg());
  }

  private sendYou(seat: Seat): void {
    const msg: YouMsg = { slot: seat.st.slot, ammo: seat.ammo };
    seat.client?.send(S_YOU, msg);
  }

  private syncMsg(withGrid: boolean): SyncMsg {
    return {
      seed: this.seed,
      round: this.state.round,
      rle: withGrid ? this.grid.toRLE() : undefined,
      hash: this.grid.hash(),
      tanks: this.tanks().map(packTank),
    };
  }

  private sendSync(c: Client, withGrid: boolean): void {
    if (!this.inMatch()) return;
    c.send(S_SYNC, this.syncMsg(withGrid));
    // Joined mid-show: let them watch what is left of it once it is over.
    if (this.phase === "PLAN") c.send(S_SNAP, this.snapshot());
  }

  // ---------------------------------------------------------------- lobby

  private onReady(c: Client, v: unknown): void {
    const seat = this.seats.get(c.sessionId);
    if (!seat || (this.phase !== "LOBBY" && this.phase !== "COUNTDOWN")) return;
    seat.st.ready = v === true;
    this.checkStart();
  }

  private onBot(c: Client, v: unknown): void {
    const seat = this.seats.get(c.sessionId);
    if (!seat?.st.host || this.phase !== "LOBBY") return;
    if (v === 1) {
      const slot = this.freeSlot();
      if (slot < 0) return;
      const st = new PlayerState();
      st.name = this.uniqueName(THEME.botNames[this.botCounter % THEME.botNames.length]);
      st.slot = slot;
      st.bot = true;
      st.ready = true;
      const id = `bot${this.botCounter++}`;
      this.seats.set(id, {
        id, st, brain: newBrain(), queue: [], lastBits: 0, ack: 0, plans: [null, null],
        ammo: initialAmmo(), stats: zeroStats(), order: this.joinCounter++,
      });
      this.state.players.set(id, st);
    } else if (v === -1) {
      const bots = [...this.seats.values()].filter((s) => s.brain).sort((a, b) => b.order - a.order);
      if (bots[0]) this.removeSeat(bots[0]);
    }
    this.checkStart();
  }

  private checkStart(): void {
    const present = this.humans().filter((s) => s.st.connected && s.st.slot >= 0);
    const allReady = present.length > 0 && present.every((s) => s.st.ready);
    if (this.phase === "LOBBY" && allReady) {
      this.setPhase("COUNTDOWN", this.ms(TIMING.COUNTDOWN), () => this.startMatch());
    } else if (this.phase === "COUNTDOWN" && !allReady) {
      this.toLobby();
    }
  }

  private toLobby(): void {
    for (const s of this.seats.values()) {
      s.tank = undefined;
      s.st.inMatch = false;
      s.st.alive = false;
      s.st.locked = false;
      s.st.ready = !!s.brain;
      s.st.hp = 0;
      // someone was watching because the table was full: seat them if we can
      if (s.st.slot < 0) s.st.slot = this.freeSlot();
    }
    this.state.round = 0;
    this.setPhase("LOBBY", 0);
  }

  // ---------------------------------------------------------------- match

  private startMatch(): void {
    const players = [...this.seats.values()]
      .filter((s) => s.st.slot >= 0 && (s.brain || s.st.connected))
      .sort((a, b) => a.st.slot - b.st.slot);
    if (!players.some((s) => !s.brain)) return this.toLobby();

    this.seed = (Math.random() * 0x100000000) >>> 0;
    this.grid = generateTerrain(this.seed);
    const spawns = findSpawns(this.grid, players.length, mulberry32(this.seed ^ 0x9e3779b9));
    players.forEach((s, i) => {
      s.tank = makeTank(s.st.slot, spawns[i].x, spawns[i].y);
      s.tank.hp = this.hp;
      s.tank.facing = spawns[i].x < (this.grid.w * 256) / 2 ? 1 : -1;
      s.ammo = initialAmmo();
      s.stats = zeroStats();
      s.st.inMatch = true;
      s.st.alive = true;
      s.st.hp = this.hp;
      s.st.dealt = 0;
      s.st.kills = 0;
      this.sendYou(s);
    });
    this.startedWith = players.length;
    this.state.round = 0;
    this.broadcast(S_SYNC, this.syncMsg(false));
    this.beginRound();
  }

  private beginRound(): void {
    this.state.round++;
    // Anyone who arrived mid-match and has a seat gets a pot now.
    const alive = this.tanks().filter((t) => t.alive);
    const avg = alive.length ? Math.ceil(alive.reduce((a, t) => a + t.hp, 0) / alive.length) : this.hp;
    let joined = false;
    for (const s of this.seats.values()) {
      if (s.st.inMatch || s.st.slot < 0 || !s.st.connected || s.brain) continue;
      const p = perch(this.grid, 20 + Math.floor(Math.random() * (this.grid.w - 40)));
      s.tank = makeTank(s.st.slot, p.x, p.y);
      s.tank.hp = Math.max(1, Math.min(this.hp, Math.max(50, avg)));
      s.ammo = initialAmmo();
      s.stats = zeroStats();
      s.st.inMatch = true;
      s.st.alive = true;
      s.st.hp = s.tank.hp;
      this.startedWith++;
      this.sendYou(s);
      joined = true;
    }
    for (const s of this.matchSeats()) {
      const t = s.tank!;
      t.dig = POT.digEnergy;
      t.vx = 0;
      t.vy = 0;
      ensureFree(this.grid, t);
      s.queue.length = 0;
      s.lastBits = 0;
      s.plans = [null, null];
      s.st.locked = false;
    }
    // The world is no longer what the seed alone produces, so this roster
    // update has to carry the grid (a few KB of RLE, once per late joiner).
    if (joined) this.broadcast(S_SYNC, this.syncMsg(true));
    this.moveTick = 0;
    this.setPhase("MOVE", this.ms(TIMING.MOVE), () => this.beginPlan());
  }

  // ----------------------------------------------------------------- MOVE

  private onInput(c: Client, v: unknown): void {
    if (this.phase !== "MOVE") return;
    const seat = this.seats.get(c.sessionId);
    if (!seat?.tank?.alive || !Array.isArray(v) || v.length !== 2) return;
    const seq = v[0];
    const bits = v[1];
    if (!Number.isInteger(seq) || !Number.isInteger(bits) || seq <= seat.ack) return;
    if (seat.queue.length >= 16) return; // flooding: drop
    seat.queue.push(seq, bits & IN_MASK);
  }

  private onMoveTick(): void {
    if (this.phase !== "MOVE") return;
    this.moveTick++;
    const nextTea = teaRowFor(this.state.round + 1);
    for (const s of this.matchSeats()) {
      const t = s.tank!;
      if (!t.alive) continue;
      let bits = s.lastBits;
      if (s.brain) bits = botInput(s.brain, t, this.moveTick, nextTea, this.grid);
      else if (s.queue.length) {
        // One input per tick keeps everyone at the same speed; if a burst
        // arrived late, skip ahead rather than fall behind.
        while (s.queue.length > 6) s.queue.splice(0, 2);
        s.ack = s.queue.shift()!;
        bits = s.queue.shift()!;
      }
      s.lastBits = bits;
      stepTank(this.grid, t, bits, false);
      stepTank(this.grid, t, bits, false);
      const before = t.dig;
      const e = tankDig(this.grid, t, bits);
      if (e) {
        s.stats.dug += before - t.dig;
        const msg: EditMsg = { id: t.id, e };
        this.broadcast(S_EDIT, msg);
      }
    }
    this.broadcast(S_SNAP, this.snapshot());
  }

  private snapshot(): (number | number[])[] {
    const out: (number | number[])[] = [this.moveTick];
    for (const s of this.matchSeats()) {
      const t = s.tank!;
      if (!t.alive) continue;
      out.push([t.id, t.x, t.y, t.vx, t.vy, (t.grounded ? 1 : 0) | (t.facing > 0 ? 2 : 0) | (s.lastBits & 8 ? 4 : 0), s.ack, t.dig, t.debt]);
    }
    return out;
  }

  // ----------------------------------------------------------------- PLAN

  private beginPlan(): void {
    this.broadcast(S_SNAP, this.snapshot());
    for (const s of this.matchSeats()) {
      s.plans = [null, null];
      s.st.locked = false;
      s.lastBits = 0;
    }
    this.setPhase("PLAN", this.ms(TIMING.PLAN), () => this.doResolve());
    // Bots think at their own pace so the roster fills with ticks like a real table.
    const tanks = this.tanks();
    for (const s of this.matchSeats()) {
      if (!s.brain || !s.tank!.alive) continue;
      const round = this.state.round;
      this.clock.setTimeout(() => {
        if (this.phase !== "PLAN" || this.state.round !== round || !s.tank?.alive) return;
        s.plans = this.checkAmmo(s, botPlan(this.grid, s.tank, tanks, s.ammo));
        s.st.locked = true;
        this.checkAllLocked();
      }, this.ms(1500 + Math.random() * 7000));
    }
    this.checkAllLocked();
  }

  /** Drop any slot the player has no ammo for. */
  private checkAmmo(seat: Seat, plans: PlanPair): PlanPair {
    const left = { ...seat.ammo };
    const out: PlanPair = [null, null];
    for (let i = 0; i < 2; i++) {
      const p = plans[i];
      if (!p) continue;
      const n = left[p.w];
      if (n === 0 || n === undefined) continue;
      if (n > 0) left[p.w] = n - 1;
      out[i] = p;
    }
    return out;
  }

  private onPlan(c: Client, v: unknown): void {
    if (this.phase !== "PLAN") return;
    const seat = this.seats.get(c.sessionId);
    if (!seat?.tank?.alive || seat.st.locked || !v || typeof v !== "object") return;
    const raw = v as { plans?: unknown; lock?: unknown };
    if (!Array.isArray(raw.plans)) return;
    seat.plans = this.checkAmmo(seat, [sanitizePlan(raw.plans[0]), sanitizePlan(raw.plans[1])]);
    if (raw.lock === true) {
      seat.st.locked = true;
      this.checkAllLocked();
    }
  }

  private checkAllLocked(): void {
    if (this.phase !== "PLAN") return;
    const waiting = this.matchSeats().filter((s) => s.tank!.alive && !s.st.locked && (s.brain || s.st.connected));
    const soon = this.ms(TIMING.PLAN_LOCKED);
    if (waiting.length === 0 && this.phaseEndsAt - Date.now() > soon) {
      this.timer?.clear();
      this.phaseEndsAt = Date.now() + soon;
      this.broadcast(S_PHASE, this.phaseMsg());
      this.timer = this.clock.setTimeout(() => this.doResolve(), soon);
    }
  }

  // -------------------------------------------------------------- RESOLVE

  private doResolve(): void {
    if (this.phase !== "PLAN") return;
    const seats = this.matchSeats();
    // Round-trip every pot through the wire format first: the sim must start
    // from exactly what clients are told, with no leftover velocity or
    // per-round scratch state that the message does not carry.
    for (const s of seats) Object.assign(s.tank!, unpackTank(packTank(s.tank!)));
    const tanks = seats.map((s) => s.tank!);
    const plans: Record<number, PlanPair> = {};
    for (const s of seats) if (s.tank!.alive) plans[s.tank!.id] = s.plans;
    const teaRow = teaRowFor(this.state.round);
    const aliveBefore = tanks.filter((t) => t.alive).length;

    const msg: ResolveMsg = {
      round: this.state.round,
      tanks: tanks.map(packTank),
      plans,
      teaRow,
      pre: this.grid.hash(),
      post: 0,
      ms: 0,
    };
    // The whole show is computed here, in one go. Clients replay it from the
    // same inputs; `post` lets them prove they arrived at the same world.
    const events = runResolve(this.grid, tanks, plans, teaRow);
    const timeline = buildTimeline(events, aliveBefore);
    msg.post = worldHash(this.grid, tanks);
    msg.ms = timeline.totalMs;
    this.lastResolve = msg;
    this.tally(events, seats);

    this.setPhase("RESOLVE", this.ms(timeline.totalMs), () => this.beginAftermath());
    this.broadcast(S_RESOLVE, msg);
    for (const s of seats) this.sendYou(s);
  }

  private tally(events: SimEvent[], seats: Seat[]): void {
    const bySlot = new Map(seats.map((s) => [s.tank!.id, s]));
    this.deathTicks.clear();
    for (const e of events) {
      if (e.k === "fire") {
        const s = bySlot.get(e.a!);
        if (s && e.w && s.ammo[e.w] > 0) s.ammo[e.w]--;
      } else if (e.k === "dmg") {
        const v = bySlot.get(e.v!);
        const a = bySlot.get(e.a!);
        if (v) v.stats.taken += e.n ?? 0;
        if (a && a !== v) a.stats.dealt += e.n ?? 0;
        if (a && a === v) a.stats.self += e.n ?? 0;
      } else if (e.k === "death") {
        this.deathTicks.set(e.v!, e.t);
        const a = bySlot.get(e.a!);
        if (a && a.tank!.id !== e.v) a.stats.kills++;
      }
    }
  }

  private beginAftermath(): void {
    // Only now does the public roster learn the outcome, so HUDs cannot spoil the show.
    for (const s of this.matchSeats()) {
      s.st.hp = s.tank!.hp;
      s.st.alive = s.tank!.alive;
      s.st.dealt = Math.min(65535, s.stats.dealt);
      s.st.kills = s.stats.kills;
      s.st.locked = false;
    }
    this.setPhase("AFTERMATH", this.ms(TIMING.AFTERMATH), () => {
      const alive = this.matchSeats().filter((s) => s.tank!.alive);
      const lastStanding = this.startedWith > 1 ? alive.length <= 1 : alive.length === 0;
      if (lastStanding || this.state.round >= this.rounds) this.gameOver(alive);
      else this.beginRound();
    });
  }

  private gameOver(alive: Seat[]): void {
    let winner = -1;
    let reason: OverMsg["reason"] = "draw";
    if (alive.length === 1) {
      winner = alive[0].st.slot;
      reason = "last";
    } else if (alive.length > 1) {
      const top = [...alive].sort((a, b) => b.tank!.hp - a.tank!.hp);
      if (top[0].tank!.hp > top[1].tank!.hp) {
        winner = top[0].st.slot;
        reason = "rounds";
      }
    } else if (this.deathTicks.size > 1) {
      // Everyone broke in the same Pour: whoever held out longest wins.
      // Shattering on the same tick (the tea scalds everyone at once) stays a draw.
      const order = this.matchSeats()
        .filter((s) => this.deathTicks.has(s.tank!.id))
        .sort((a, b) => this.deathTicks.get(b.tank!.id)! - this.deathTicks.get(a.tank!.id)!);
      if (order.length > 1 && this.deathTicks.get(order[0].tank!.id)! > this.deathTicks.get(order[1].tank!.id)!) {
        winner = order[0].st.slot;
        reason = "outlasted";
      }
    }
    const seats = this.matchSeats();
    const awards: OverMsg["awards"] = [];
    const best = (key: string, f: (s: Seat) => number, min: number) => {
      const top = [...seats].sort((a, b) => f(b) - f(a))[0];
      if (top && f(top) >= min) awards.push({ slot: top.st.slot, key });
    };
    best("crumbs", (s) => s.stats.dealt, 1);
    best("shatter", (s) => s.stats.kills, 1);
    best("mole", (s) => s.stats.dug, 60);
    best("own", (s) => s.stats.self, 1);
    best("untouched", (s) => (s.tank!.alive ? 1000 - s.stats.taken : 0), 1);
    const msg: OverMsg = {
      winner,
      reason,
      rows: seats
        .map((s) => ({
          slot: s.st.slot, name: s.st.name, hp: s.tank!.hp, alive: s.tank!.alive, dealt: s.stats.dealt, kills: s.stats.kills, bot: !!s.brain,
        }))
        .sort((a, b) => Number(b.alive) - Number(a.alive) || b.hp - a.hp || b.dealt - a.dealt),
      awards,
    };
    this.setPhase("GAME_OVER", this.ms(TIMING.GAME_OVER), () => this.toLobby());
    this.broadcast(S_OVER, msg);
  }
}

// Keep the weapon table referenced so a bad content edit fails at boot, not mid-match.
for (const w of SELECTABLE) if (!WEAPON_BY_ID[w.id]) throw new Error(`weapon ${w.id} not indexed`);
