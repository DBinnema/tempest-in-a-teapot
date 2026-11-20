/**
 * Colyseus room state: the small, slow-changing part of the game that every
 * client should always agree on (roster, phase, round). High-frequency and
 * secret data (MOVE snapshots, plans, resolve inputs) travel as messages.
 *
 * Defined with defineTypes rather than decorators so it runs unchanged under
 * tsc, tsx and vitest without experimentalDecorators plumbing.
 */
import { defineTypes, MapSchema, Schema } from "@colyseus/schema";

export class PlayerState extends Schema {
  declare name: string;
  /** 0..7 = seat/colour; -1 = spectator-only (table is full) */
  declare slot: number;
  declare hp: number;
  declare alive: boolean;
  /** has a pot in the current match */
  declare inMatch: boolean;
  declare ready: boolean;
  declare connected: boolean;
  /** plan locked in (a fact, never the plan itself) */
  declare locked: boolean;
  declare bot: boolean;
  declare host: boolean;
  declare dealt: number;
  declare kills: number;

  constructor() {
    super();
    this.name = "";
    this.slot = -1;
    this.hp = 0;
    this.alive = false;
    this.inMatch = false;
    this.ready = false;
    this.connected = true;
    this.locked = false;
    this.bot = false;
    this.host = false;
    this.dealt = 0;
    this.kills = 0;
  }
}
defineTypes(PlayerState, {
  name: "string",
  slot: "int8",
  hp: "int16",
  alive: "boolean",
  inMatch: "boolean",
  ready: "boolean",
  connected: "boolean",
  locked: "boolean",
  bot: "boolean",
  host: "boolean",
  dealt: "uint16",
  kills: "uint8",
});

export class RoomState extends Schema {
  declare phase: string;
  declare round: number;
  declare maxRounds: number;
  declare players: MapSchema<PlayerState>;

  constructor() {
    super();
    this.phase = "LOBBY";
    this.round = 0;
    this.maxRounds = 0;
    this.players = new MapSchema<PlayerState>();
  }
}
defineTypes(RoomState, {
  phase: "string",
  round: "uint8",
  maxRounds: "uint8",
  players: { map: PlayerState },
});
