/**
 * Thin wrapper over the Colyseus room: one place that knows the endpoint
 * rules, and that quietly reconnects when the socket drops.
 */
import { Client, Room } from "colyseus.js";
import { RECONNECT_GRACE_S, ROOM_NAME } from "../../shared/src/protocol";
import type { Identity } from "./discord";

export type NetStatus = "connecting" | "online" | "reconnecting" | "offline";

const KEY = "teapot.rt";

function endpoint(embedded: boolean): string {
  const ws = location.protocol === "https:" ? "wss:" : "ws:";
  // Vite dev server: the game server is the other process on :2567.
  if (import.meta.env.DEV) return `ws://${location.hostname}:2567`;
  // Production is single-origin. Inside Discord everything goes via /.proxy.
  return `${ws}//${location.host}${embedded ? "/.proxy" : ""}`;
}

export class Net {
  room?: Room;
  status: NetStatus = "connecting";
  onStatus: () => void = () => undefined;
  onState: () => void = () => undefined;
  private handlers = new Map<string, (m: any) => void>();
  private client!: Client;
  private options: Record<string, unknown> = {};
  private closed = false;

  on(type: string, fn: (m: any) => void): void {
    this.handlers.set(type, fn);
  }

  send(type: string, msg?: unknown): void {
    if (this.room && this.status === "online") {
      try {
        this.room.send(type, msg);
      } catch {
        /* socket is closing; the reconnect path will take over */
      }
    }
  }

  get sessionId(): string {
    return this.room?.sessionId ?? "";
  }

  async connect(id: Identity): Promise<void> {
    this.client = new Client(endpoint(id.embedded));
    const q = new URLSearchParams(location.search);
    this.options = { name: id.name, instanceId: id.instanceId };
    // Test knobs; the server ignores them unless started with TEAPOT_TEST=1.
    for (const k of ["fast", "hp", "rounds"]) if (q.has(k)) this.options[k] = Number(q.get(k));

    let token = "";
    try {
      token = sessionStorage.getItem(KEY) ?? "";
    } catch {
      /* no storage */
    }
    if (token) {
      try {
        this.attach(await this.client.reconnect(token));
        return;
      } catch {
        /* seat is gone; join fresh */
      }
    }
    await this.join();
  }

  private async join(): Promise<void> {
    for (let attempt = 0; !this.closed; attempt++) {
      try {
        this.attach(await this.client.joinOrCreate(ROOM_NAME, this.options));
        return;
      } catch (e) {
        // A sleeping free-tier server takes a while to wake: keep knocking.
        this.setStatus(attempt < 40 ? "connecting" : "offline");
        await new Promise((r) => setTimeout(r, Math.min(4000, 800 + attempt * 400)));
      }
    }
  }

  private attach(room: Room): void {
    this.room = room;
    try {
      sessionStorage.setItem(KEY, room.reconnectionToken);
    } catch {
      /* no storage */
    }
    room.onMessage("*", (type, msg) => this.handlers.get(String(type))?.(msg));
    room.onStateChange(() => this.onState());
    room.onLeave((code) => {
      if (this.closed || this.room !== room) return;
      void this.recover(room, code);
    });
    this.setStatus("online");
    this.onState();
  }

  private async recover(room: Room, code: number): Promise<void> {
    this.setStatus("reconnecting");
    const deadline = Date.now() + (RECONNECT_GRACE_S - 3) * 1000;
    // 4000+ are deliberate server closes; there is no seat to come back to.
    while (code < 4000 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1200));
      try {
        this.attach(await this.client.reconnect(room.reconnectionToken));
        return;
      } catch {
        /* try again */
      }
    }
    await this.join();
  }

  private setStatus(s: NetStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.onStatus();
  }
}
