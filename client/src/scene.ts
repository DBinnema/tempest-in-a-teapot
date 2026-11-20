/**
 * The one Phaser scene. It mirrors the server's world (seed + edits +
 * replayed resolves), predicts the local pot during MOVE, offers planning
 * tools during PLAN, and stages the RESOLVE replay.
 *
 * Nothing here is authoritative. Whenever a hash disagrees with the
 * server's, the scene throws its world away and asks for a fresh copy.
 */
import * as Phaser from "phaser";
import { POT } from "../../shared/src/content/tanks";
import { SELECTABLE, WEAPON_BY_ID } from "../../shared/src/content/weapons";
import { buildTimeline, PRE_ROLL_MS, Timeline } from "../../shared/src/director";
import { FP } from "../../shared/src/fixed";
import { Grid, WORLD_H, WORLD_W } from "../../shared/src/grid";
import {
  C_BOT, C_INPUT, C_PLAN, C_READY, C_SYNC, EditMsg, OverMsg, Phase, PhaseMsg, ResolveMsg, S_EDIT, S_OVER, S_PHASE, S_RESOLVE,
  S_SNAP, S_SYNC, S_YOU, SyncMsg, YouMsg,
} from "../../shared/src/protocol";
import { BEAT2, MIN_POWER, Plan, PlanPair, ResolveSim, SimEvent, worldHash } from "../../shared/src/sim";
import {
  applyDigEdit, cloneTank, digTarget, IN_DIG, IN_DOWN, IN_JUMP, IN_LEFT, IN_RIGHT, IN_UP, stepTank, Tank, unpackTank,
} from "../../shared/src/tank";
import { generateTerrain } from "../../shared/src/terrain";
import { THEME, weaponSkin } from "../../shared/src/theme";
import { Sfx } from "./audio";
import { drawPot, drawSweet, paintSky } from "./draw";
import { Particles } from "./fx";
import { Net } from "./net";
import { buildRecap } from "./recap";
import { CELL, TerrainView } from "./terrainView";
import { glazeCss, nameTag, RecapLine, Ui, UiModel, UiPlayer } from "./ui";

/** world pixels per fixed-point unit */
const S = CELL / FP;
const W_PX = WORLD_W * CELL;
const H_PX = WORLD_H * CELL;
const MOVE_MS = 1000 / 30;
/**
 * How much of each lump's flight the planning preview reveals, in ticks.
 * The full exact arc made every shot at a pot that didn't hop a sure hit;
 * a second of flight shows direction, strength and the first bounce, and
 * leaves the landing to judgement. (The self-damage warning and your own
 * ghost after a hop still come from the full sim.)
 */
const PREVIEW_TICKS = 60;

interface PotVis {
  x: number;
  y: number;
  /** position at the previous sim tick, for replay interpolation */
  px: number;
  py: number;
  squash: number;
  hurt: number;
  aim: number;
  hp: number;
  digging: boolean;
  label: Phaser.GameObjects.Text;
  blink: number;
}

interface Preview {
  paths: number[][];
  booms: number[][];
  builds: number[][];
  ghost2: { x: number; y: number } | null;
  end: { x: number; y: number } | null;
  hits: Set<number>;
  self: boolean;
}

interface Replay {
  msg: ResolveMsg;
  sim: ResolveSim;
  tl: Timeline;
  clock: number;
  due: number;
  span: number;
  hold: number;
  evIdx: number;
  cue: number;
  done: boolean;
  dings: number;
  prev: Map<number, number[]>;
  trails: Map<number, number[]>;
  spin: number;
  recap: RecapLine[];
  hot: { x: number; y: number; until: number }[];
  deathsThisTick: number;
}

export class GameScene extends Phaser.Scene {
  private grid = new Grid(WORLD_W, WORLD_H);
  private view!: TerrainView;
  private gfx!: Phaser.GameObjects.Graphics;
  private parts = new Particles();
  private tanks: Tank[] = [];
  private vis = new Map<number, PotVis>();
  private names = new Map<number, string>();

  private phase: Phase = "LOBBY";
  private round = 0;
  private phaseEnd = 0;
  private phaseDur = 1;
  private teaRow = WORLD_H;
  private nextTeaRow = WORLD_H;
  private teaY = H_PX + 40;
  private mySlot = -1;
  private ammo: Record<string, number> = {};
  private over?: OverMsg;
  private maxHp = POT.hp;

  // MOVE prediction
  private seq = 0;
  private pending: number[] = [];
  private moveAcc = 0;
  private keys!: Record<string, Phaser.Input.Keyboard.Key>;
  private lastDigSound = 0;

  // PLAN
  private slots: (Plan | null)[] = [null, null];
  private pinned = [false, false];
  private active = 0;
  private locked = false;
  private planDirty = false;
  private planSent = 0;
  private preview: Preview | null = null;
  private previewDirty = false;
  private previewAt = 0;
  private lastTick = -1;

  // RESOLVE
  private replay: Replay | null = null;
  private recap: RecapLine[] = [];
  private reveal: UiModel["reveal"] = [];

  // camera
  private mouse = { x: 0, y: 0, down: false, panning: false };
  private userZoom = 1;
  private pan = { x: 0, y: 0 };
  private cam = { x: W_PX / 2, y: H_PX / 2, z: 0.5 };
  private uiDirty = true;
  private now = 0;
  private lastReal = 0;
  private demoSeed = 0;

  constructor(
    private net: Net,
    private ui: Ui,
    private sfx: Sfx,
  ) {
    super("game");
  }

  // ------------------------------------------------------------- set-up

  create(): void {
    const sky = this.textures.createCanvas("sky", 640, 400)!;
    paintSky(sky.getContext(), 640, 400);
    sky.refresh();
    this.add.image(W_PX / 2, H_PX / 2 - 180, "sky").setDisplaySize(W_PX + 3600, H_PX + 2200).setDepth(0);
    this.cameras.main.setBackgroundColor(THEME.sky.bottom);
    this.view = new TerrainView(this, WORLD_W, WORLD_H, 10);
    this.gfx = this.add.graphics().setDepth(20);
    this.showDemo();

    const kb = this.input.keyboard!;
    this.keys = kb.addKeys("W,A,S,D,UP,DOWN,LEFT,RIGHT,SPACE,SHIFT,F") as Record<string, Phaser.Input.Keyboard.Key>;
    kb.addCapture("TAB,SPACE,UP,DOWN,LEFT,RIGHT");
    kb.on("keydown", (e: KeyboardEvent) => this.onKey(e));
    this.input.mouse?.disableContextMenu();
    this.input.on("pointermove", (p: Phaser.Input.Pointer) => {
      if (this.mouse.panning) {
        this.pan.x -= (p.x - this.mouse.x) / this.cam.z;
        this.pan.y -= (p.y - this.mouse.y) / this.cam.z;
      }
      this.mouse.x = p.x;
      this.mouse.y = p.y;
      if (this.phase === "PLAN") this.aimFromMouse(false);
    });
    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => {
      this.sfx.unlock();
      this.mouse.x = p.x;
      this.mouse.y = p.y;
      if (p.rightButtonDown() || p.middleButtonDown()) this.mouse.panning = true;
      else if (this.phase === "PLAN") this.aimFromMouse(true);
    });
    this.input.on("pointerup", () => (this.mouse.panning = false));
    this.input.on("wheel", (_p: unknown, _o: unknown, _dx: number, dy: number) => {
      this.userZoom = Phaser.Math.Clamp(this.userZoom * (dy > 0 ? 0.88 : 1.14), 1, 4);
      if (this.userZoom === 1) this.pan.x = this.pan.y = 0;
    });

    const n = this.net;
    n.on(S_PHASE, (m: PhaseMsg) => this.onPhase(m));
    n.on(S_SYNC, (m: SyncMsg) => this.onSync(m));
    n.on(S_SNAP, (m: (number | number[])[]) => this.onSnap(m));
    n.on(S_EDIT, (m: EditMsg) => this.onEdit(m));
    n.on(S_RESOLVE, (m: ResolveMsg) => this.onResolve(m));
    n.on(S_OVER, (m: OverMsg) => {
      this.over = m;
      this.uiDirty = true;
      this.sfx.play("fanfare");
      this.sfx.play("fanfare", { pitch: 1.26, delay: 0.16 });
      this.sfx.play("fanfare", { pitch: 1.5, delay: 0.32 });
      this.sfx.play("dingHi", { delay: 0.5 });
    });
    n.on(S_YOU, (m: YouMsg) => {
      this.mySlot = m.slot;
      this.ammo = m.ammo;
      this.uiDirty = true;
    });
    n.onState = () => {
      this.net.room?.state.players?.forEach((p: any) => {
        if (p.slot >= 0) this.names.set(p.slot, p.name);
      });
      this.uiDirty = true;
    };
    n.onStatus = () => (this.uiDirty = true);
    n.onState();
    this.ui.onAct = (act, arg) => this.onAct(act, arg);
    this.lastReal = performance.now();
  }

  /** A fresh cake to look at behind the lobby. */
  private showDemo(): void {
    this.demoSeed = (Math.random() * 0xffffffff) >>> 0;
    this.grid = generateTerrain(this.demoSeed);
    this.view.setGrid(this.grid);
    this.setTanks([]);
  }

  private setTanks(tanks: Tank[]): void {
    this.tanks = tanks;
    const ids = new Set(tanks.map((t) => t.id));
    for (const [id, v] of this.vis) {
      if (!ids.has(id)) {
        v.label.destroy();
        this.vis.delete(id);
      }
    }
    for (const t of tanks) {
      let v = this.vis.get(t.id);
      if (!v) {
        const label = this.add
          .text(0, 0, "", {
            fontFamily: THEME.font.body, fontSize: "11px", color: THEME.ui.ink, stroke: THEME.ui.paper, strokeThickness: 3, resolution: 3,
          })
          .setOrigin(0.5, 1)
          .setDepth(40);
        v = { x: t.x * S, y: t.y * S, px: t.x * S, py: t.y * S, squash: 0, hurt: 0, aim: t.facing > 0 ? 350 : 1450, hp: t.hp, digging: false, label, blink: Math.random() * 4 };
        this.vis.set(t.id, v);
      }
      v.x = v.px = t.x * S;
      v.y = v.py = t.y * S;
      v.hp = t.hp;
    }
  }

  private me(): Tank | undefined {
    return this.mySlot >= 0 ? this.tanks.find((t) => t.id === this.mySlot) : undefined;
  }

  private nameOf(id: number): string {
    return this.names.get(id) ?? `Pot ${id + 1}`;
  }

  // ----------------------------------------------------------- messages

  private onPhase(m: PhaseMsg): void {
    const changed = m.phase !== this.phase || m.round !== this.round;
    const prev = this.phase;
    this.phase = m.phase;
    this.round = m.round;
    this.phaseEnd = performance.now() + m.ms;
    if (changed) this.phaseDur = Math.max(1, m.ms);
    this.teaRow = m.teaRow;
    this.nextTeaRow = m.nextTeaRow;
    this.uiDirty = true;
    if (!changed) return;
    this.lastTick = -1;
    this.sfx.setMusic(m.phase === "RESOLVE" ? 0.25 : m.phase === "PLAN" ? 0.7 : 1);

    if (m.phase !== "RESOLVE" && m.phase !== "AFTERMATH" && this.replay && !this.replay.done) this.finishReplay();
    switch (m.phase) {
      case "LOBBY":
        this.replay = null;
        this.over = undefined;
        this.userZoom = 1;
        if (prev !== "COUNTDOWN") this.showDemo();
        break;
      case "COUNTDOWN":
        this.sfx.play("ding");
        break;
      case "MOVE":
        this.replay = null;
        this.pending.length = 0;
        this.moveAcc = 0;
        this.pan.x = this.pan.y = 0;
        this.ui.callout(THEME.phase.MOVE, "beat");
        this.sfx.play("ding", { pitch: 0.75 });
        break;
      case "PLAN": {
        this.pending.length = 0;
        const me = this.me();
        this.slots = [me?.alive ? { w: "sugar", angle: me.facing > 0 ? 450 : 1350, power: 650 } : null, null];
        this.pinned = [false, false];
        this.active = 0;
        this.locked = false;
        this.planDirty = true;
        this.previewDirty = true;
        this.preview = null;
        this.pan.x = this.pan.y = 0;
        this.ui.callout(THEME.phase.PLAN, "beat");
        this.sfx.play("ding");
        break;
      }
      case "AFTERMATH":
        if (this.replay && !this.replay.done) this.finishReplay();
        this.recap = this.replay?.recap ?? [];
        break;
      default:
        break;
    }
  }

  private onSync(m: SyncMsg): void {
    if (m.rle) {
      this.grid = new Grid(WORLD_W, WORLD_H);
      this.grid.loadRLE(m.rle);
    } else this.grid = generateTerrain(m.seed);
    this.view.setGrid(this.grid);
    this.replay = null;
    this.pending.length = 0;
    this.setTanks(m.tanks.map(unpackTank));
    this.maxHp = Math.max(1, ...this.tanks.map((t) => t.hp), this.round <= 1 ? 1 : this.maxHp);
    this.uiDirty = true;
  }

  private onSnap(m: (number | number[])[]): void {
    if (this.phase !== "MOVE" && this.phase !== "PLAN") return;
    for (let i = 1; i < m.length; i++) {
      const a = m[i] as number[];
      const t = this.tanks.find((x) => x.id === a[0]);
      const v = this.vis.get(a[0]);
      if (!t || !v) continue;
      t.x = a[1];
      t.y = a[2];
      t.vx = a[3];
      t.vy = a[4];
      t.grounded = !!(a[5] & 1);
      t.facing = a[5] & 2 ? 1 : -1;
      v.digging = !!(a[5] & 4);
      t.dig = a[7];
      t.debt = a[8] ?? 0;
      if (t.id === this.mySlot && this.phase === "MOVE") {
        // Reconcile: rewind to the server's word, replay what it has not seen.
        const p = this.pending;
        let k = 0;
        while (k < p.length && p[k] <= a[6]) k += 2;
        p.splice(0, k);
        for (let j = 0; j < p.length; j += 2) {
          stepTank(this.grid, t, p[j + 1], false);
          stepTank(this.grid, t, p[j + 1], false);
        }
      }
    }
  }

  private onEdit(m: EditMsg): void {
    applyDigEdit(this.grid, m.e);
    const x = m.e.x * S;
    const y = m.e.y * S;
    this.parts.burst(x, y, 5, THEME.fx.crumbs, 70, { life: 0.5, up: 30 });
    if (this.now - this.lastDigSound > 90) {
      this.lastDigSound = this.now;
      this.sfx.play("dig", { pitch: 0.8 + Math.random() * 0.5, gain: m.id === this.mySlot ? 1 : 0.5 });
    }
  }

  private onResolve(m: ResolveMsg): void {
    if (this.grid.hash() !== m.pre) {
      // We have drifted. Skip the show rather than show a lie.
      this.net.send(C_SYNC);
      return;
    }
    const tanks = m.tanks.map(unpackTank);
    // Dry run on a copy: the whole outcome, so the director can pace it.
    const dry = new ResolveSim(this.grid.clone(), tanks.map(cloneTank), m.plans, m.teaRow);
    const events = dry.runToEnd();
    const alive = tanks.filter((t) => t.alive).length;
    this.setTanks(tanks);
    this.reveal = tanks
      .filter((t) => t.alive)
      .map((t) => ({ slot: t.id, name: this.nameOf(t.id), w: [m.plans[t.id]?.[0]?.w ?? null, m.plans[t.id]?.[1]?.w ?? null] }));
    this.replay = {
      msg: m,
      sim: new ResolveSim(this.grid, tanks, m.plans, m.teaRow),
      tl: buildTimeline(events, alive),
      clock: 0,
      due: 0,
      span: 16.7,
      hold: 0,
      evIdx: 0,
      cue: 0,
      done: false,
      dings: 0,
      prev: new Map(),
      trails: new Map(),
      spin: 0,
      recap: buildRecap(events, (id) => nameTag(id, this.nameOf(id))),
      hot: [],
      deathsThisTick: 0,
    };
    for (const t of tanks) {
      const v = this.vis.get(t.id)!;
      const p = m.plans[t.id]?.[0] ?? m.plans[t.id]?.[1];
      if (p && WEAPON_BY_ID[p.w]?.kind !== "shield") v.aim = p.angle;
    }
    this.pan.x = this.pan.y = 0;
    this.userZoom = 1;
  }

  /** Skip to the end of the show without the show (we fell behind). */
  private finishReplay(): void {
    const r = this.replay;
    if (!r || r.done) return;
    r.sim.runToEnd();
    this.endReplay(r);
  }

  private endReplay(r: Replay): void {
    r.done = true;
    r.prev.clear();
    for (const t of this.tanks) {
      const v = this.vis.get(t.id);
      if (v) {
        v.px = v.x = t.x * S;
        v.py = v.y = t.y * S;
      }
    }
    if (worldHash(this.grid, r.sim.tanks) !== r.msg.post) this.net.send(C_SYNC);
  }

  // -------------------------------------------------------------- input

  private onAct(act: string, arg: string): void {
    this.sfx.unlock();
    this.sfx.play("click");
    const meP = this.model().me;
    switch (act) {
      case "ready":
        this.net.send(C_READY, !meP?.ready);
        break;
      case "bot":
        this.net.send(C_BOT, Number(arg));
        break;
      case "mute":
        this.sfx.setMuted(!this.sfx.muted);
        break;
      case "slot":
        this.active = Number(arg) ? 1 : 0;
        break;
      case "clear":
        this.clearSlot(Number(arg) ? 1 : 0);
        break;
      case "weapon":
        this.pickWeapon(arg);
        break;
      case "lock":
        this.lockIn();
        break;
    }
    this.uiDirty = true;
  }

  private onKey(e: KeyboardEvent): void {
    this.sfx.unlock();
    const k = e.key.toLowerCase();
    if (k === "m") {
      this.sfx.setMuted(!this.sfx.muted);
      this.uiDirty = true;
    }
    if (this.phase === "LOBBY" && (k === "enter" || k === " ")) this.onAct("ready", "");
    if (this.phase !== "PLAN" || this.locked) return;
    const me = this.me();
    if (!me?.alive) return;
    if (k >= "1" && k <= "9") {
      const w = SELECTABLE[Number(k) - 1];
      if (w) this.pickWeapon(w.id);
    } else if (k === "tab" || k === "q" || k === "e") {
      this.active ^= 1;
      this.sfx.play("click");
    } else if (k === "r" || k === "backspace" || k === "delete") this.clearSlot(this.active);
    else if (k === "enter" || k === " ") this.lockIn();
    else if (k.startsWith("arrow")) {
      const p = this.slots[this.active];
      if (!p) return;
      const fine = e.shiftKey ? 1 : 10;
      if (k === "arrowleft") p.angle = (p.angle + fine) % 3600;
      if (k === "arrowright") p.angle = (p.angle + 3600 - fine) % 3600;
      if (k === "arrowup") p.power = Math.min(1000, p.power + fine);
      if (k === "arrowdown") p.power = Math.max(MIN_POWER, p.power - fine);
      this.pinned[this.active] = true;
      this.planChanged();
    } else return;
    this.uiDirty = true;
  }

  private planChanged(): void {
    this.planDirty = true;
    this.previewDirty = true;
  }

  private ammoLeft(w: string, exceptSlot: number): number {
    const def = WEAPON_BY_ID[w];
    if (!def || def.ammo < 0) return 99;
    const other = this.slots[exceptSlot ^ 1];
    return (this.ammo[w] ?? 0) - (other?.w === w ? 1 : 0);
  }

  private pickWeapon(w: string): void {
    if (this.phase !== "PLAN" || this.locked || !this.me()?.alive) return;
    if (this.ammoLeft(w, this.active) <= 0) return;
    const cur = this.slots[this.active];
    const me = this.me()!;
    this.slots[this.active] = { w, angle: cur?.angle ?? (me.facing > 0 ? 450 : 1350), power: cur?.power ?? 650 };
    if (WEAPON_BY_ID[w].kind === "shield") this.pinned[this.active] = true;
    else if (!cur) {
      this.pinned[this.active] = false;
      this.aimFromMouse(false);
    }
    this.sfx.play("click", { pitch: 1.3 });
    this.planChanged();
    this.uiDirty = true;
  }

  private clearSlot(i: number): void {
    if (this.locked) return;
    this.slots[i] = null;
    this.pinned[i] = false;
    this.active = i;
    this.planChanged();
    this.uiDirty = true;
  }

  private lockIn(): void {
    if (this.phase !== "PLAN" || this.locked || !this.me()?.alive) return;
    this.locked = true;
    this.net.send(C_PLAN, { plans: this.slots, lock: true });
    this.planDirty = false;
    this.sfx.play("lock");
    this.uiDirty = true;
  }

  /** Where lump `i` will be fired from (lump two: wherever lump one leaves us). */
  private aimOrigin(i: number): { x: number; y: number } {
    const me = this.me();
    if (!me) return { x: 0, y: 0 };
    if (i === 1 && this.preview?.ghost2) return { x: this.preview.ghost2.x, y: this.preview.ghost2.y - (POT.ht >> 1) * S };
    return { x: me.x * S, y: (me.y - (POT.ht >> 1)) * S };
  }

  private aimFromMouse(pin: boolean): void {
    if (this.locked || this.phase !== "PLAN") return;
    const p = this.slots[this.active];
    if (!p || !this.me()?.alive) return;
    if (!pin && this.pinned[this.active]) return;
    if (WEAPON_BY_ID[p.w]?.kind !== "shield") {
      const w = this.cameras.main.getWorldPoint(this.mouse.x, this.mouse.y);
      const o = this.aimOrigin(this.active);
      const dx = w.x - o.x;
      const dy = w.y - o.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 4) {
        p.angle = (Math.round((Math.atan2(-dy, dx) * 1800) / Math.PI) + 3600) % 3600;
        p.power = Phaser.Math.Clamp(Math.round((dist / 240) * 1000), MIN_POWER, 1000);
      }
    }
    if (pin) {
      this.pinned[this.active] = true;
      this.sfx.play("click", { pitch: 1.5 });
      // First lump pinned: move on to the (optional) second.
      if (this.active === 0 && !this.slots[1]) this.active = 1;
      this.uiDirty = true;
    }
    this.planChanged();
  }

  // ---------------------------------------------------------- per frame

  update(_time: number, delta: number): void {
    const real = performance.now();
    const realDt = Math.min(2500, real - this.lastReal);
    this.lastReal = real;
    this.now = real;
    const dt = Math.min(0.05, delta / 1000);
    let fxDt = dt;

    if (this.phase === "MOVE") this.updateMove(delta);
    if (this.phase === "PLAN") this.updatePlan(real);
    if (this.replay && !this.replay.done) fxDt = this.updateReplay(this.replay, realDt, dt);

    this.updateVis(dt);
    this.parts.update(fxDt);
    this.view.update();
    this.updateCamera(dt);
    this.draw(dt);

    // HUD timer + last-seconds ticking while planning
    const left = Math.max(0, this.phaseEnd - real);
    const secs = Math.ceil(left / 1000);
    const timed = this.phase === "MOVE" || this.phase === "PLAN";
    this.ui.setTimer(timed || this.phase === "AFTERMATH" || this.phase === "GAME_OVER" ? left / this.phaseDur : 0, timed ? secs : 0, timed && secs <= 5);
    if (timed && secs <= 5 && secs !== this.lastTick && secs > 0) {
      if (this.lastTick !== -1) this.sfx.play("tick", { pitch: this.phase === "PLAN" ? 1 : 0.8 });
      this.lastTick = secs;
    }
    if (this.uiDirty) {
      this.uiDirty = false;
      this.ui.render(this.model());
    }
  }

  private updateMove(delta: number): void {
    const me = this.me();
    this.moveAcc = Math.min(this.moveAcc + delta, MOVE_MS * 4);
    while (this.moveAcc >= MOVE_MS) {
      this.moveAcc -= MOVE_MS;
      if (!me?.alive) continue;
      const K = this.keys;
      const dig = K.SHIFT.isDown || K.F.isDown;
      let bits = 0;
      if (K.A.isDown || K.LEFT.isDown) bits |= IN_LEFT;
      if (K.D.isDown || K.RIGHT.isDown) bits |= IN_RIGHT;
      if (dig) {
        bits |= IN_DIG;
        if (K.W.isDown || K.UP.isDown) bits |= IN_UP;
        if (K.S.isDown || K.DOWN.isDown) bits |= IN_DOWN;
        if (K.SPACE.isDown) bits |= IN_JUMP;
      } else if (K.W.isDown || K.UP.isDown || K.SPACE.isDown) bits |= IN_JUMP;
      const wasGrounded = me.grounded;
      this.net.send(C_INPUT, [++this.seq, bits]);
      this.pending.push(this.seq, bits);
      if (this.pending.length > 60) this.pending.splice(0, 2);
      stepTank(this.grid, me, bits, false);
      stepTank(this.grid, me, bits, false);
      if (wasGrounded && !me.grounded && bits & IN_JUMP) this.sfx.play("boing", { gain: 0.35, pitch: 1.4 });
      const v = this.vis.get(me.id);
      if (v) {
        v.digging = dig;
        if (!wasGrounded && me.grounded) v.squash = 0.6;
      }
    }
    const dig = me ? me.dig / POT.digEnergy : 0;
    if (Math.abs(dig - this.shownDig) > 0.02 || (dig === 0) !== (this.shownDig === 0)) {
      this.shownDig = dig;
      this.uiDirty = true;
    }
  }
  private shownDig = 1;

  private updatePlan(real: number): void {
    if (this.planDirty && !this.locked && real - this.planSent > 200) {
      // Sent unlocked too, so the timer running out still fires what you see.
      this.net.send(C_PLAN, { plans: this.slots, lock: false });
      this.planSent = real;
      this.planDirty = false;
    }
    if (this.previewDirty && real - this.previewAt > 50) {
      this.previewAt = real;
      this.previewDirty = false;
      this.computePreview();
    }
  }

  /** PLAN tool: run the real sim with only our own lumps and trace the result. */
  private computePreview(): void {
    const me = this.me();
    if (!me?.alive) {
      this.preview = null;
      return;
    }
    const tanks = this.tanks.map(cloneTank);
    const sim = new ResolveSim(this.grid.clone(), tanks, { [me.id]: [this.slots[0], this.slots[1]] as PlanPair }, this.teaRow);
    const mine = tanks.find((t) => t.id === me.id)!;
    const paths = new Map<number, number[]>();
    const born = new Map<number, number>();
    const pv: Preview = { paths: [], booms: [], builds: [], ghost2: null, end: null, hits: new Set(), self: false };
    const shown = (t: number) => t < PREVIEW_TICKS || (t >= BEAT2 && t < BEAT2 + PREVIEW_TICKS);
    let ev = 0;
    while (!sim.done && sim.tick < 520) {
      sim.step();
      for (const p of sim.projs) {
        if (p.dead) continue;
        if (!born.has(p.id)) born.set(p.id, sim.tick);
        if (sim.tick - born.get(p.id)! >= PREVIEW_TICKS) continue;
        let a = paths.get(p.id);
        if (!a) paths.set(p.id, (a = []));
        a.push(p.x * S, p.y * S);
      }
      if (sim.tick === BEAT2 && this.slots[1]) pv.ghost2 = { x: mine.x * S, y: mine.y * S };
      for (; ev < sim.events.length; ev++) {
        const e = sim.events[ev];
        if (e.k === "dmg" && e.v === me.id) pv.self = true;
        if (!shown(e.t)) continue;
        if (e.k === "boom") pv.booms.push([e.x! * S, e.y! * S, e.r! * S]);
        else if (e.k === "build") pv.builds.push([e.x! * S, e.y! * S, e.r! * S]);
        else if (e.k === "dmg" && e.v !== me.id) pv.hits.add(e.v!);
      }
    }
    pv.paths = [...paths.values()];
    if (mine.alive && (Math.abs(mine.x - me.x) > 200 || Math.abs(mine.y - me.y) > 200)) pv.end = { x: mine.x * S, y: mine.y * S };
    if (pv.ghost2 && Math.abs(pv.ghost2.x - me.x * S) < 3 && Math.abs(pv.ghost2.y - me.y * S) < 3) pv.ghost2 = null;
    this.preview = pv;
  }

  /** Advance the show. Returns the time step particles should use (slow-mo aware). */
  private updateReplay(r: Replay, realDt: number, dt: number): number {
    r.clock += realDt;
    if (r.clock < PRE_ROLL_MS) {
      // Count-in: three dings while the plans are revealed over every pot.
      const n = Math.floor((r.clock - 500) / 500) + 1;
      if (n > r.dings && n <= 3) {
        r.dings = n;
        this.sfx.play("ding", { pitch: 0.9 + n * 0.08 });
      }
      return dt;
    }
    if (r.dings < 4) {
      r.dings = 4;
      r.due = 0;
      this.ui.callout(THEME.phase.RESOLVE, "beat");
      this.sfx.play("dingHi");
      realDt = Math.min(realDt, 34);
    }
    r.due -= realDt;
    let steps = 0;
    while (r.due <= 0 && !r.sim.done) {
      const i = r.sim.tick;
      r.prev.clear();
      for (const p of r.sim.projs) if (!p.dead) r.prev.set(p.id, [p.x * S, p.y * S]);
      for (const t of r.sim.tanks) {
        const v = this.vis.get(t.id);
        if (v) {
          v.px = t.x * S;
          v.py = t.y * S;
        }
      }
      r.sim.step();
      r.deathsThisTick = 0;
      const loud = steps < 4; // far behind (tab was hidden): catch up quietly
      for (; r.evIdx < r.sim.events.length; r.evIdx++) if (loud) this.onSimEvent(r.sim.events[r.evIdx], r);
      for (const p of r.sim.projs) {
        if (p.dead) {
          r.trails.delete(p.id);
          continue;
        }
        let tr = r.trails.get(p.id);
        if (!tr) r.trails.set(p.id, (tr = []));
        tr.push(p.x * S, p.y * S);
        if (tr.length > 44) tr.splice(0, 2);
      }
      const idx = Math.min(i, r.tl.ticks - 1);
      r.span = r.tl.ms[idx];
      r.hold = r.tl.hold[idx];
      r.due += r.span + r.hold;
      steps++;
      if (steps > 400) break;
    }
    if (r.sim.done) {
      this.endReplay(r);
      return dt;
    }
    // Hit-stop comes first (freeze on the frame of impact), then the tick plays.
    const frozen = r.due > r.span;
    const scale = frozen ? 0 : 1000 / 60 / r.span;
    r.spin += dt * scale * 9;
    return dt * scale;
  }

  /** One simulation event -> picture and sound. */
  private onSimEvent(e: SimEvent, r: Replay): void {
    const x = (e.x ?? 0) * S;
    const y = (e.y ?? 0) * S;
    const F = THEME.fx;
    const C = THEME.words.callouts;
    const glaze = (id: number | undefined) => THEME.glazes[(((id ?? 0) % 8) + 8) % 8];
    const cam = this.cameras.main;
    switch (e.k) {
      case "fire": {
        const skin = weaponSkin(e.w!);
        const v = this.vis.get(e.a!);
        if (v) {
          v.squash = 0.7;
          v.aim = e.r ?? v.aim;
        }
        const rad = ((e.r ?? 900) / 1800) * Math.PI;
        this.parts.burst(x + Math.cos(rad) * 14, y - Math.sin(rad) * 14, 7, [F.smoke, 0xffffff], 60, { kind: 1, g: -40, life: 0.5, size: 4 });
        this.sfx.play(skin.fire, { pitch: 0.9 + ((e.a ?? 0) % 4) * 0.07 });
        break;
      }
      case "fizzle":
        this.sfx.play("fizzle", { gain: 0.6 });
        break;
      case "jump":
        this.parts.burst(x, y, 16, [F.smoke, 0xffffff], 90, { kind: 1, g: -30, life: 0.7, size: 5 });
        this.sfx.play("whistle");
        break;
      case "shield":
        this.sfx.play("ting");
        break;
      case "shieldEnd":
        this.sfx.play("tink", { pitch: 0.7 });
        break;
      case "boom": {
        const rr = (e.r ?? 0) * S;
        const big = Math.min(1.6, rr / 36);
        this.parts.flash(x, y, rr, F.flash);
        this.parts.ring(x, y, rr * 1.25, 0xffffff);
        this.parts.burst(x, y, Math.round(10 + rr * 0.7), F.fire, 150 + rr * 3, { kind: 3, g: 60, life: 0.35, size: 4 });
        this.parts.burst(x, y, Math.round(8 + rr * 0.9), F.crumbs, 120 + rr * 4, { up: 60, life: 1.1 });
        this.parts.burst(x, y, 6, [F.smoke], 40, { kind: 1, g: -50, life: 1, size: rr * 0.3 });
        this.sfx.play(e.w === "bomblet" ? "pop" : "boom", { gain: 0.5 + big * 0.5, pitch: 1.5 - big * 0.45 });
        cam.shake(120 + big * 120, 0.002 + big * 0.004);
        r.hot.push({ x, y, until: r.clock + 900 });
        break;
      }
      case "build":
        this.parts.burst(x, y, 16, [0xf7e6bf, 0xfff7ea], 110, { up: 40 });
        this.parts.ring(x, y, (e.r ?? 0) * S, 0xf7e6bf);
        this.sfx.play("splat");
        r.hot.push({ x, y, until: r.clock + 700 });
        break;
      case "dmg": {
        const v = this.vis.get(e.v!);
        if (v) v.hurt = 1;
        const col = e.a !== undefined && e.a >= 0 && e.a !== e.v ? glazeCss(e.a) : THEME.ui.accent;
        this.floatText(x, y - 14, `−${e.n}`, col, 11 + Math.min(10, (e.n ?? 0) / 4));
        this.sfx.play(e.c === "tea" ? "sizzle" : "hurt", { pitch: 1.2 - Math.min(0.5, (e.n ?? 0) / 100) });
        if (e.c === "tea") this.floatText(x, y - 30, C.scald, "#c8792b", 12);
        if (e.c === "crush") this.floatText(x, y - 30, C.crush, THEME.ui.ink, 12);
        r.hot.push({ x, y, until: r.clock + 900 });
        break;
      }
      case "death": {
        const gz = glaze(e.v);
        this.parts.burst(x, y, 34, [F.porcelain, gz.body, gz.light, gz.dark], 260, { up: 90, life: 1.5, size: 3.4 });
        this.parts.flash(x, y, 30, 0xffffff, 0.2);
        this.parts.ring(x, y, 44, gz.body, 0.5);
        this.sfx.play("shatter");
        this.sfx.play("dingHi", { pitch: 0.5, gain: 0.6 });
        cam.shake(260, 0.008);
        r.deathsThisTick++;
        const who = this.nameOf(e.v!);
        const cue = r.tl.cues.find((c) => c.t === e.t && c.v === e.v);
        if (cue?.kind === "final") this.ui.callout(C.final, "final");
        else if (r.deathsThisTick > 1) this.ui.callout(C.double, "kill");
        else if (e.a === e.v) this.ui.callout(`${who}: ${C.own}`, "kill");
        else if (e.w === "shatter") this.ui.callout(C.chain, "kill");
        else this.ui.callout(`${who} ${C.kill}`, "kill");
        r.hot.push({ x, y, until: r.clock + 1500 });
        break;
      }
      case "block":
        this.parts.ring(x, y - 8, 28, 0xa6ece6, 0.3);
        this.sfx.play("tink");
        break;
      case "reflect":
        this.parts.ring(x, y, 12, 0xffffff, 0.3);
        this.parts.burst(x, y, 8, [0xffffff, 0xa6ece6], 120, { life: 0.4, g: 0 });
        this.sfx.play("ting", { pitch: 1.3 });
        this.ui.callout(C.reflect, "small");
        break;
      case "bounce":
        this.sfx.play(e.n ? "boing" : "tink", { gain: 0.7 });
        this.parts.burst(x, y, 3, F.crumbs, 50, { life: 0.3 });
        break;
      case "split":
        this.parts.ring(x, y, 16, 0xf2b632, 0.3);
        this.parts.burst(x, y, 12, [0xf2b632, 0xffffff, 0xe8425a, 0x2fb8b0], 140, { life: 0.5, g: 100 });
        this.sfx.play("pop", { pitch: 1.6 });
        break;
      case "clash":
        this.parts.flash(x, y, 40, 0xffffff, 0.22);
        this.parts.ring(x, y, 50, 0xffffff, 0.5);
        this.parts.burst(x, y, 24, F.fire, 240, { kind: 3, life: 0.5, g: 0, size: 3 });
        this.sfx.play("ding", { pitch: 1.4 });
        this.ui.callout(C.clash, "kill");
        r.hot.push({ x, y, until: r.clock + 1100 });
        break;
      case "drill":
        if (e.t % 3 === 0) {
          this.parts.burst(x, y, 3, F.crumbs, 70, { life: 0.4 });
          this.sfx.play("dig", { pitch: 1.6, gain: 0.6 });
        }
        break;
      case "crack":
        this.sfx.play("crack");
        this.parts.burst(x, y, 10, F.crumbs, 60, { life: 0.6 });
        r.hot.push({ x, y, until: r.clock + 1200 });
        break;
      case "crumbs":
        this.parts.burst(x, y, Math.min(12, e.n ?? 4), F.crumbs, 50, { life: 0.8 });
        break;
      case "thud": {
        const n = Math.min(1, (e.n ?? 0) / 300);
        this.sfx.play("thud", { gain: 0.4 + n * 0.6 });
        this.parts.burst(x, y, 6 + Math.round(n * 14), [F.smoke, ...F.crumbs], 80, { kind: 1, g: -20, life: 0.6, size: 4 });
        cam.shake(120 + n * 160, 0.002 + n * 0.006);
        break;
      }
      case "land": {
        const v = this.vis.get(e.v!);
        if (v && (e.n ?? 0) > 120) {
          v.squash = Math.min(1, (e.n ?? 0) / 500);
          this.parts.burst(x, y, 4, [F.smoke], 40, { kind: 1, g: -10, life: 0.35, size: 3 });
          this.sfx.play("thunk", { gain: 0.3, pitch: 1.5 });
        }
        break;
      }
      case "bonk":
        this.sfx.play("tink", { pitch: 0.6, gain: 0.6 });
        break;
      case "boing":
        this.sfx.play("boing");
        break;
      default:
        break;
    }
    if (e.t === BEAT2 && e.k === "fire" && (e.n ?? 0) === 1 && !this.beatAnnounced.has(r)) {
      this.beatAnnounced.add(r);
      this.ui.callout(THEME.words.lumps[1] + "!", "small beat");
    }
  }
  private beatAnnounced = new WeakSet<Replay>();

  private floatText(x: number, y: number, s: string, color: string, size: number): void {
    const t = this.add
      .text(x + (Math.random() - 0.5) * 10, y, s, {
        fontFamily: THEME.font.display, fontSize: `${Math.round(size)}px`, color, stroke: THEME.ui.paper, strokeThickness: 4, resolution: 3,
      })
      .setOrigin(0.5, 1)
      .setDepth(45);
    this.tweens.add({ targets: t, y: y - 26, alpha: { from: 1, to: 0 }, duration: 1300, ease: "Cubic.easeIn", onComplete: () => t.destroy() });
  }

  private updateVis(dt: number): void {
    const r = this.replay && !this.replay.done && this.replay.clock >= PRE_ROLL_MS ? this.replay : null;
    const alpha = r ? Phaser.Math.Clamp(1 - Math.min(r.due, r.span) / r.span, 0, 1) : 1;
    for (const t of this.tanks) {
      const v = this.vis.get(t.id);
      if (!v) continue;
      const tx = t.x * S;
      const ty = t.y * S;
      if (r) {
        v.x = v.px + (tx - v.px) * alpha;
        v.y = v.py + (ty - v.py) * alpha;
      } else {
        // Smooth over 30 Hz snapshots and prediction corrections; snap if far.
        const k = Math.abs(tx - v.x) + Math.abs(ty - v.y) > 60 ? 1 : Math.min(1, dt * 22);
        v.x += (tx - v.x) * k;
        v.y += (ty - v.y) * k;
      }
      v.squash = Math.max(0, v.squash - dt * 4);
      v.hurt = Math.max(0, v.hurt - dt * 3.5);
      v.hp += (t.hp - v.hp) * Math.min(1, dt * 8);
      v.blink = (v.blink + dt) % 4.2;
    }
  }

  // -------------------------------------------------------------- camera

  private updateCamera(dt: number): void {
    const cam = this.cameras.main;
    const vw = this.scale.width;
    const vh = this.scale.height;
    // Keep the world clear of the HUD: more room at the bottom while planning.
    const top = vh * 0.05;
    // keep pots clear of the weapon tray (Steep) and the recap card (Crumbs)
    const bottom = this.phase === "PLAN" ? vh * 0.17 : this.phase === "AFTERMATH" ? vh * 0.2 : vh * 0.04;
    const aw = vw;
    const ah = Math.max(60, vh - top - bottom);
    const fit = Math.min(aw / W_PX, ah / H_PX);
    let tx = W_PX / 2;
    let ty = H_PX / 2;
    let tz = fit;
    let rate = 4;
    const me = this.me();
    const mv = me ? this.vis.get(me.id) : undefined;

    if (this.phase === "LOBBY" || this.phase === "COUNTDOWN") {
      tz = fit * 1.5;
      tx = W_PX / 2 + Math.sin(this.now / 9000) * W_PX * 0.2;
      ty = H_PX * 0.45;
      rate = 1.5;
    } else if (this.phase === "MOVE") {
      if (me?.alive && mv) {
        tz = fit * 1.75 * this.userZoom;
        tx = mv.x;
        ty = mv.y - 20;
        rate = 6;
      }
    } else if (this.phase === "PLAN") {
      tz = fit * this.userZoom;
      if (this.userZoom > 1.02 && mv) {
        tx = mv.x + this.pan.x;
        ty = mv.y - 30 + this.pan.y;
      }
    } else if (this.phase === "RESOLVE" && this.replay && !this.replay.done) {
      const f = this.focus(this.replay);
      if (f) {
        tx = (f.x0 + f.x1) / 2;
        ty = (f.y0 + f.y1) / 2;
        tz = Phaser.Math.Clamp(Math.min(aw / (f.x1 - f.x0), ah / (f.y1 - f.y0)), fit, fit * 2.6);
        rate = f.rate;
      }
    }
    // Do not show much beyond the cake unless the whole cake fits.
    const hw = aw / 2 / tz;
    const hh = ah / 2 / tz;
    tx = hw * 2 >= W_PX + 80 ? W_PX / 2 : Phaser.Math.Clamp(tx, hw - 40, W_PX - hw + 40);
    ty = hh * 2 >= H_PX + 80 ? H_PX / 2 : Phaser.Math.Clamp(ty, hh - 260, H_PX - hh + 30);

    const k = 1 - Math.exp(-dt * rate);
    this.cam.x += (tx - this.cam.x) * k;
    this.cam.y += (ty - this.cam.y) * k;
    this.cam.z += (tz - this.cam.z) * k;
    if (this.cam.z < fit * 0.5) this.cam.z = fit; // first frame / after a resize
    cam.setZoom(this.cam.z);
    cam.centerOn(this.cam.x, this.cam.y + (bottom - top) / 2 / this.cam.z);
  }

  /** The director's framing: what is happening, and what is about to. */
  private focus(r: Replay): { x0: number; y0: number; x1: number; y1: number; rate: number } | null {
    if (r.clock < PRE_ROLL_MS) return null;
    let x0 = 1e9;
    let y0 = 1e9;
    let x1 = -1e9;
    let y1 = -1e9;
    let rate = 3;
    const add = (x: number, y: number, pad: number) => {
      x0 = Math.min(x0, x - pad);
      y0 = Math.min(y0, y - pad);
      x1 = Math.max(x1, x + pad);
      y1 = Math.max(y1, y + pad);
    };
    // A shattering is coming: be there first, and close.
    const tick = r.sim.tick;
    const cue = r.tl.cues.find((c) => c.t >= tick - 8 && c.t - tick < 46);
    if (cue && cue.kind !== "clash") {
      add(cue.x * S, cue.y * S, cue.kind === "final" ? 130 : 170);
      for (const p of r.sim.projs) if (!p.dead && Math.abs(p.x * S - cue.x * S) < 320 && Math.abs(p.y * S - cue.y * S) < 260) add(p.x * S, p.y * S, 40);
      return { x0, y0, x1, y1, rate: 5 };
    }
    for (const p of r.sim.projs) if (!p.dead) add(p.x * S, Math.max(-200, p.y * S), 110);
    r.hot = r.hot.filter((h) => h.until > r.clock);
    for (const h of r.hot) add(h.x, h.y, 150);
    for (const t of r.sim.tanks) {
      if (!t.alive) continue;
      if (t.vx !== 0 || Math.abs(t.vy) > 40 || t.shield > 0 || tick < 30 || (tick >= BEAT2 - 20 && tick < BEAT2 + 20)) add(t.x * S, t.y * S - 8, 120);
    }
    if (x1 < x0) for (const t of r.sim.tanks) if (t.alive) add(t.x * S, t.y * S, 150);
    if (x1 < x0) return null;
    if (cue) rate = 4;
    return { x0, y0, x1, y1, rate };
  }

  // ---------------------------------------------------------------- draw

  private draw(dt: number): void {
    const g = this.gfx;
    g.clear();
    const r = this.replay && !this.replay.done ? this.replay : null;
    const inMatch = this.phase !== "LOBBY" && this.phase !== "COUNTDOWN";

    // cloche domes sit behind their pots
    if (r) {
      for (const t of r.sim.tanks) {
        if (!t.alive || t.shield <= 0) continue;
        const v = this.vis.get(t.id)!;
        const rad = WEAPON_BY_ID.cloche.radius * S;
        const fading = t.shield < 45 && Math.floor(t.shield / 5) % 2 === 0;
        g.fillStyle(0xa6ece6, fading ? 0.08 : 0.22);
        g.fillCircle(v.x, v.y - 8, rad);
        g.lineStyle(2, 0xffffff, fading ? 0.3 : 0.85);
        g.strokeCircle(v.x, v.y - 8, rad);
        g.lineStyle(2, 0xffffff, 0.6);
        g.beginPath();
        g.arc(v.x, v.y - 8, rad - 5, -2.3, -1.5);
        g.strokePath();
      }
    }

    for (const t of this.tanks) {
      const v = this.vis.get(t.id);
      if (!v) continue;
      const glaze = THEME.glazes[t.id % 8];
      v.label.setVisible(inMatch);
      if (!inMatch) continue;
      if (!t.alive) {
        // what is left: a few shards and a lonely lid
        v.label.setVisible(false);
        g.fillStyle(THEME.ink, 0.9);
        g.fillTriangle(v.x - 9, v.y, v.x - 3, v.y - 6, v.x - 1, v.y);
        g.fillTriangle(v.x + 1, v.y, v.x + 6, v.y - 4, v.x + 10, v.y);
        g.fillStyle(glaze.body, 1);
        g.fillTriangle(v.x - 7.5, v.y - 0.5, v.x - 3.2, v.y - 4.6, v.x - 2, v.y - 0.5);
        g.fillTriangle(v.x + 2.4, v.y - 0.5, v.x + 6, v.y - 3, v.x + 8.4, v.y - 0.5);
        continue;
      }
      let aim = v.aim;
      if (!r && this.phase !== "RESOLVE") {
        aim = t.facing > 0 ? 350 : 1450;
        if (this.phase === "PLAN" && t.id === this.mySlot) aim = this.slots[this.active]?.angle ?? aim;
      }
      drawPot(g, v.x, v.y, {
        glaze, aim, facing: t.facing, squash: v.squash, hurt: v.hurt, alpha: 1, blink: v.blink > 4.05, me: t.id === this.mySlot,
      });
      // name + tea gauge
      // Zoomed far out, names and gauges grow so they stay readable.
      const us = this.uiScale();
      const hpw = 22 * us;
      const hph = 3 * us;
      const top = v.y - 23 - hph - us;
      g.fillStyle(THEME.ink, 1);
      g.fillRect(v.x - hpw / 2 - 1, top - 1, hpw + 2, hph + 2);
      g.fillStyle(0xfff4e0, 1);
      g.fillRect(v.x - hpw / 2, top, hpw, hph);
      g.fillStyle(v.hp > this.maxHp * 0.3 ? 0xc8792b : 0xe8425a, 1);
      g.fillRect(v.x - hpw / 2, top, (hpw * Math.max(0, v.hp)) / this.maxHp, hph);
      v.label.setText(this.nameOf(t.id)).setPosition(v.x, top - 2).setScale(us);
      if (t.id === this.mySlot && (this.phase === "MOVE" || this.phase === "PLAN")) {
        const bob = Math.sin(this.now / 180) * 1.5;
        g.fillStyle(0xf2b632, 1);
        const ay = top - 6 - 13 * us + bob;
        g.fillStyle(THEME.ink, 1);
        g.fillTriangle(v.x - 5.5 * us, ay - 1.5, v.x + 5.5 * us, ay - 1.5, v.x, ay + 6.5 * us);
        g.fillStyle(0xf2b632, 1);
        g.fillTriangle(v.x - 4 * us, ay, v.x + 4 * us, ay, v.x, ay + 5 * us);
      }
      if (this.phase === "MOVE" && v.digging && t.dig > 0) {
        const K = this.keys;
        const mine = t.id === this.mySlot;
        const bits = mine ? (K.A.isDown || K.LEFT.isDown ? IN_LEFT : 0) | (K.D.isDown || K.RIGHT.isDown ? IN_RIGHT : 0) | (K.W.isDown || K.UP.isDown ? IN_UP : 0) | (K.S.isDown || K.DOWN.isDown ? IN_DOWN : 0) : 0;
        if (mine) {
          const d = digTarget(t, bits | IN_DIG);
          g.lineStyle(1.5, 0xf2b632, 0.9);
          g.strokeCircle(d.x * S, d.y * S, POT.digRadius * S);
        }
      }
    }

    if (r) this.drawReplay(g, r);
    this.parts.draw(g);
    this.drawTea(g, dt);
    if (this.phase === "PLAN" && !this.locked) this.drawPlan(g);
  }

  /** How much to enlarge world-space labels so they hold their size on screen. */
  private uiScale(): number {
    return Phaser.Math.Clamp(0.95 / this.cam.z, 1, 2.4);
  }

  private drawReplay(g: Phaser.GameObjects.Graphics, r: Replay): void {
    const us = this.uiScale();
    if (r.clock < PRE_ROLL_MS) {
      // The reveal: every pot shows its hand before anything moves.
      for (const t of r.sim.tanks) {
        if (!t.alive) continue;
        const v = this.vis.get(t.id)!;
        const pl = r.msg.plans[t.id] ?? [null, null];
        for (let i = 0; i < 2; i++) {
          const at = 250 + i * 450;
          if (r.clock < at) continue;
          const k = Math.min(1, (r.clock - at) / 180);
          const ox = v.x + (i ? 11 : -11) * us;
          const oy = v.y - 30 - 24 * us - (1 - k) * 8;
          g.fillStyle(THEME.ink, 0.9 * k);
          g.fillCircle(ox, oy, 10.5 * us);
          g.fillStyle(0xfff4e0, k);
          g.fillCircle(ox, oy, 9 * us);
          const p = pl[i];
          if (p) {
            const skin = weaponSkin(p.w);
            if (skin.art === "puff" || skin.art === "dome") {
              g.lineStyle(2, THEME.ink, k);
              g.fillStyle(skin.color, k);
              if (skin.art === "dome") {
                g.beginPath();
                g.arc(ox, oy + 3 * us, 6 * us, Math.PI, 0);
                g.closePath();
                g.fillPath();
                g.strokePath();
              } else {
                g.fillCircle(ox - 2.5 * us, oy + us, 3.6 * us);
                g.fillCircle(ox + 2.5 * us, oy + 1.5 * us, 3.2 * us);
                g.fillCircle(ox, oy - 2 * us, 3.8 * us);
                g.strokeCircle(ox, oy, 6.5 * us);
              }
            } else drawSweet(g, skin.art, skin.color, ox, oy, 0.3, 1.25 * k * us, k);
            // a stub of an arrow: which way, and how hard
            if (i === 0 && WEAPON_BY_ID[p.w]?.kind !== "shield") {
              const rad = (p.angle / 1800) * Math.PI;
              const len = (14 + p.power * 0.03) * k * us;
              const cx = v.x;
              const cy = v.y - 8;
              g.lineStyle(3.5 * us, THEME.ink, 0.8 * k);
              g.lineBetween(cx + Math.cos(rad) * 18, cy - Math.sin(rad) * 18, cx + Math.cos(rad) * (18 + len), cy - Math.sin(rad) * (18 + len));
              g.lineStyle(2 * us, THEME.glazes[t.id % 8].light, k);
              g.lineBetween(cx + Math.cos(rad) * 18, cy - Math.sin(rad) * 18, cx + Math.cos(rad) * (18 + len), cy - Math.sin(rad) * (18 + len));
            }
          } else {
            g.lineStyle(1.5, THEME.ink, 0.35 * k);
            g.lineBetween(ox - 3, oy, ox + 3, oy);
          }
        }
      }
      return;
    }
    const alpha = Phaser.Math.Clamp(1 - Math.min(r.due, r.span) / r.span, 0, 1);
    const ps = Math.min(1.7, 0.6 + us * 0.55);
    // trails are tinted by owner so you can always tell whose shot it is
    for (const p of r.sim.projs) {
      if (p.dead) continue;
      const tr = r.trails.get(p.id);
      const gz = THEME.glazes[((p.owner % 8) + 8) % 8];
      if (tr) {
        for (let i = 0; i < tr.length; i += 2) {
          const k = i / tr.length;
          g.fillStyle(gz.body, k * THEME.fx.trailAlpha);
          g.fillCircle(tr[i], tr[i + 1], (0.8 + k * 2.6) * ps);
        }
      }
    }
    for (const p of r.sim.projs) {
      if (p.dead) continue;
      const prev = r.prev.get(p.id);
      const x = prev ? prev[0] + (p.x * S - prev[0]) * alpha : p.x * S;
      const y = prev ? prev[1] + (p.y * S - prev[1]) * alpha : p.y * S;
      const skin = weaponSkin(p.w.id);
      const gz = THEME.glazes[((p.owner % 8) + 8) % 8];
      const spin = skin.art === "screw" ? Math.atan2(p.vy, p.vx) : r.spin + p.id;
      g.fillStyle(gz.body, 0.35);
      g.fillCircle(x, y, 8 * ps);
      drawSweet(g, skin.art, skin.color, x, y, spin, (p.w.id === "bomblet" ? 0.8 : 1.3) * ps);
      // off the top of the screen? leave a marker at the edge
      const view = this.cameras.main.worldView;
      if (y < view.y + 6) {
        g.fillStyle(gz.body, 0.9);
        g.fillTriangle(x - 5, view.y + 12, x + 5, view.y + 12, x, view.y + 4);
      }
      // a jawbreaker blinks faster as its fuse runs down
      if (p.w.fuse && p.w.kind === "bouncer") {
        const left = p.w.fuse - p.age;
        if (left < 90 && Math.floor(left / (left < 40 ? 4 : 9)) % 2 === 0) {
          g.lineStyle(1.5, 0xe8425a, 0.9);
          g.strokeCircle(x, y, 8);
        }
      }
    }
  }

  private drawTea(g: Phaser.GameObjects.Graphics, dt: number): void {
    const target = this.phase === "LOBBY" || this.phase === "COUNTDOWN" ? H_PX + 40 : this.teaRow * CELL;
    this.teaY += (target - this.teaY) * Math.min(1, dt * 1.2);
    if (this.teaY >= H_PX + 30) return;
    const T = THEME.tea;
    const view = this.cameras.main.worldView;
    const x0 = Math.min(view.x, 0) - 50;
    const x1 = Math.max(view.right, W_PX) + 50;
    g.fillStyle(T.color, T.alpha);
    g.fillRect(x0, this.teaY, x1 - x0, H_PX + 600 - this.teaY);
    g.lineStyle(2, T.foam, 0.9);
    g.beginPath();
    for (let x = x0; x <= x1; x += 8) {
      const y = this.teaY + Math.sin(x * 0.05 + this.now / 400) * 1.6;
      if (x === x0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.strokePath();
  }

  private drawPlan(g: Phaser.GameObjects.Graphics): void {
    const me = this.me();
    const pv = this.preview;
    if (!me?.alive) return;
    const glaze = THEME.glazes[me.id % 8];
    const us = this.uiScale();
    if (pv) {
      for (const path of pv.paths) {
        // one point per tick of flight; dots every 3 ticks, fading with age
        // so the arc trails off where the preview gives up
        for (let i = 0; i < path.length; i += 6) {
          const f = 1 - (i / 2 / PREVIEW_TICKS) * 0.85;
          g.fillStyle(THEME.ink, 0.55 * f);
          g.fillCircle(path[i], path[i + 1], 2.1 * us * (0.6 + 0.4 * f));
          g.fillStyle(0xffffff, 0.95 * f);
          g.fillCircle(path[i], path[i + 1], 1.3 * us * (0.6 + 0.4 * f));
        }
      }
      for (const [x, y, rr] of pv.booms) {
        g.fillStyle(0xe8425a, 0.13);
        g.fillCircle(x, y, rr);
        g.lineStyle(1.5, 0xe8425a, 0.8);
        g.strokeCircle(x, y, rr);
      }
      for (const [x, y, rr] of pv.builds) {
        g.fillStyle(0xf7e6bf, 0.45);
        g.fillCircle(x, y, rr);
        g.lineStyle(1.5, THEME.ink, 0.6);
        g.strokeCircle(x, y, rr);
      }
      for (const ghost of [pv.ghost2, pv.end]) {
        if (!ghost) continue;
        drawPot(g, ghost.x, ghost.y, { glaze, aim: this.slots[1]?.angle ?? 450, facing: 1, squash: 0, hurt: 0, alpha: 0.4, blink: false, me: true });
      }
      // would-hit markers (if they stand still, which they will not)
      for (const id of pv.hits) {
        const v = this.vis.get(id);
        if (!v) continue;
        g.lineStyle(2, 0xe8425a, 0.9);
        g.strokeCircle(v.x, v.y - 8, 15 + Math.sin(this.now / 120) * 1.5);
      }
      if (pv.self) {
        const v = this.vis.get(me.id)!;
        g.lineStyle(2.5, 0xe8425a, 0.5 + 0.5 * Math.sin(this.now / 90));
        g.strokeCircle(v.x, v.y - 8, 19);
      }
    }
    // aim arrows for both lumps; the active one is bright
    for (let i = 0; i < 2; i++) {
      const p = this.slots[i];
      if (!p || WEAPON_BY_ID[p.w]?.kind === "shield") continue;
      const o = this.aimOrigin(i);
      const rad = (p.angle / 1800) * Math.PI;
      const len = 16 + p.power * 0.05;
      const a = i === this.active ? 1 : 0.45;
      const ex = o.x + Math.cos(rad) * len;
      const ey = o.y - Math.sin(rad) * len;
      g.lineStyle(4.5, THEME.ink, a);
      g.lineBetween(o.x + Math.cos(rad) * 14, o.y - Math.sin(rad) * 14, ex, ey);
      g.lineStyle(2.2, i ? 0x2fb8b0 : 0xf2b632, a);
      g.lineBetween(o.x + Math.cos(rad) * 14, o.y - Math.sin(rad) * 14, ex, ey);
      g.fillStyle(THEME.ink, a);
      g.fillCircle(ex, ey, 4.2);
      g.fillStyle(i ? 0x2fb8b0 : 0xf2b632, a);
      g.fillCircle(ex, ey, 2.8);
    }
  }

  // ------------------------------------------------------------ UI model

  model(): UiModel {
    const players: UiPlayer[] = [];
    const st = this.net.room?.state;
    st?.players?.forEach((p: any, id: string) => {
      players.push({
        id, name: p.name, slot: p.slot, hp: p.hp, alive: p.alive, inMatch: p.inMatch, ready: p.ready, connected: p.connected,
        locked: p.locked, bot: p.bot, host: p.host, me: id === this.net.sessionId,
      });
    });
    const me = players.find((p) => p.me);
    if (me && this.locked && this.phase === "PLAN") me.locked = true;
    return {
      phase: this.phase,
      round: this.round,
      maxRounds: st?.maxRounds ?? 0,
      players,
      me,
      status: this.net.status === "online" ? "" : this.net.status === "reconnecting" ? "Reconnecting…" : this.net.status === "offline" ? "Can't reach the kitchen. Still trying…" : "Putting the kettle on…",
      slots: this.slots,
      active: this.active,
      ammo: this.ammo,
      dig: this.shownDig,
      recap: this.recap,
      reveal: this.reveal,
      over: this.over,
      teaWarn: this.nextTeaRow < this.teaRow,
      maxHp: this.maxHp,
      muted: this.sfx.muted,
    };
  }

  /** For automated screenshots and debugging only. */
  debug(): Record<string, unknown> {
    return {
      phase: this.phase, round: this.round, slot: this.mySlot, tanks: this.tanks.length, replay: this.replay ? { tick: this.replay.sim.tick, done: this.replay.done, clock: this.replay.clock } : null,
      status: this.net.status, hash: this.grid.hash(), audio: this.sfx.state,
    };
  }
}
