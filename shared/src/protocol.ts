/** Wire protocol + match rules shared by server and client. */
import { SELECTABLE } from "./content/weapons";
import { WORLD_H } from "./grid";
import type { PlanPair, SimEvent } from "./sim";
import type { DigEdit, TankWire } from "./tank";

export const ROOM_NAME = "teapot";
export const MAX_PLAYERS = 8;
export const MAX_CLIENTS = 16;
export const MAX_ROUNDS = 12;
export const RECONNECT_GRACE_S = 30;
/** MOVE runs at 30 Hz network ticks, each two 60 Hz physics steps. */
export const MOVE_HZ = 30;

export type Phase = "LOBBY" | "COUNTDOWN" | "MOVE" | "PLAN" | "RESOLVE" | "AFTERMATH" | "GAME_OVER";

export const TIMING = {
  COUNTDOWN: 3000,
  MOVE: 12000,
  PLAN: 26000,
  /** After everyone has locked in, PLAN ends this soon. */
  PLAN_LOCKED: 900,
  AFTERMATH: 7000,
  GAME_OVER: 14000,
};

/**
 * The tea comes up from round 3 and rises faster each round (6, 7, 8 …
 * rows), so the late game squeezes the survivors together. Rows >= the
 * returned value are flooded. Tuned with tools/balance.ts.
 */
export const TEA_FROM_ROUND = 3;
export function teaRowFor(round: number): number {
  const n = round - TEA_FROM_ROUND + 1;
  return n < 1 ? WORLD_H : Math.max(60, WORLD_H - 4 - 6 * n - ((n * (n - 1)) >> 1));
}

export function initialAmmo(): Record<string, number> {
  return Object.fromEntries(SELECTABLE.map((w) => [w.id, w.ammo]));
}

/** Strip anything that is not a friendly printable character; clamp length. */
export function sanitizeName(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const s = raw
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N} _.\-'!?]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 18)
    .trim();
  return s.length ? s : fallback;
}

// ---- client -> server ------------------------------------------------------
export const C_READY = "ready"; // boolean
export const C_BOT = "bot"; // +1 | -1  (host only)
export const C_INPUT = "in"; // [seq, bits]
export const C_PLAN = "plan"; // { plans: PlanPair, lock: boolean }
export const C_SYNC = "sync?"; // ask for a full snapshot

// ---- server -> client ------------------------------------------------------
export const S_SYNC = "sync";
export const S_PHASE = "phase";
export const S_SNAP = "snap";
export const S_EDIT = "edit";
export const S_RESOLVE = "resolve";
export const S_OVER = "over";
export const S_YOU = "you";

/** Full snapshot: match start, late join, reconnect, or desync recovery. */
export interface SyncMsg {
  seed: number;
  round: number;
  /** RLE grid; omitted at match start (generate from seed instead). */
  rle?: number[];
  hash: number;
  tanks: TankWire[];
}

export interface PhaseMsg {
  phase: Phase;
  round: number;
  /** ms until the phase ends (0 = open-ended) */
  ms: number;
  teaRow: number;
  /** tea level next round, so the HUD can warn */
  nextTeaRow: number;
}

/** MOVE snapshot: tick, then per pot [id, x, y, vx, vy, flags, ack, dig]. */
export type SnapMsg = [number, ...number[][]];

export interface EditMsg {
  /** pot id that dug */
  id: number;
  e: DigEdit;
}

export interface ResolveMsg {
  round: number;
  tanks: TankWire[];
  plans: Record<number, PlanPair>;
  teaRow: number;
  /** grid hash before / world hash after, so clients can detect drift */
  pre: number;
  post: number;
  ms: number;
}

/** Private per-player info. */
export interface YouMsg {
  slot: number;
  ammo: Record<string, number>;
}

export interface OverMsg {
  /** winning slot, or -1 for a draw */
  winner: number;
  reason: "last" | "outlasted" | "rounds" | "draw" | "abandoned";
  rows: { slot: number; name: string; hp: number; alive: boolean; dealt: number; kills: number; bot: boolean }[];
  awards: { slot: number; key: string }[];
}

export type { PlanPair, SimEvent };
