/**
 * The director turns a finished RESOLVE event log into a presentation
 * timeline: how long each simulation tick stays on screen. Because the whole
 * outcome is known before the first frame is shown, the replay can slow down
 * *before* a pot shatters and freeze for a beat on a heavy hit — without
 * touching the simulation, which always advances in whole fixed ticks.
 *
 * Server and client both call this on the same events, so the server knows
 * exactly how long the show runs and when to start the next phase.
 */
import { SimEvent, TICK_HZ } from "./sim";

/** Count-in before tick 0: plans are revealed, spouts swing round, three dings. */
export const PRE_ROLL_MS = 2100;
export const TAIL_MS = 600;

export interface Cue {
  t: number;
  kind: "kill" | "final" | "clash";
  x: number;
  y: number;
  v: number;
}

export interface Timeline {
  ticks: number;
  /** ms each tick is shown for */
  ms: Float32Array;
  /** extra freeze after a tick (hit-stop) */
  hold: Float32Array;
  totalMs: number;
  cues: Cue[];
}

export function buildTimeline(events: SimEvent[], aliveAtStart: number): Timeline {
  let ticks = 0;
  for (const e of events) if (e.t > ticks) ticks = e.t;
  ticks += 1;
  const scale = new Float32Array(ticks).fill(1);
  const hold = new Float32Array(ticks);
  const cues: Cue[] = [];

  const slow = (t: number, before: number, after: number, s: number) => {
    for (let i = Math.max(0, t - before); i < Math.min(ticks, t + after); i++) {
      // ease in and out over 8 ticks so the tempo change is felt, not seen
      const edge = Math.min(i - (t - before), t + after - 1 - i);
      const k = edge >= 8 ? s : 1 - ((1 - s) * (edge + 1)) / 9;
      if (k < scale[i]) scale[i] = k;
    }
  };

  let alive = aliveAtStart;
  let stops = 0;
  for (const e of events) {
    if (e.k === "death") {
      alive--;
      const final = alive <= 1 && aliveAtStart > 1;
      slow(e.t, final ? 44 : 30, final ? 34 : 12, final ? 0.18 : 0.3);
      cues.push({ t: e.t, kind: final ? "final" : "kill", x: e.x ?? 0, y: e.y ?? 0, v: e.v ?? -1 });
    } else if (e.k === "clash") {
      slow(e.t, 14, 8, 0.45);
      cues.push({ t: e.t, kind: "clash", x: e.x ?? 0, y: e.y ?? 0, v: -1 });
    } else if (e.k === "dmg" && e.c === "blast" && (e.n ?? 0) >= 24 && stops < 10 && e.t < ticks) {
      if (hold[e.t] === 0) stops++;
      hold[e.t] = Math.max(hold[e.t], Math.min(150, 50 + (e.n ?? 0) * 2));
    }
  }

  const ms = new Float32Array(ticks);
  let total = PRE_ROLL_MS + TAIL_MS;
  for (let i = 0; i < ticks; i++) {
    ms[i] = 1000 / TICK_HZ / scale[i];
    total += ms[i] + hold[i];
  }
  return { ticks, ms, hold, totalMs: Math.ceil(total), cues };
}
