/**
 * The DOM overlay: lobby, HUD, planning panel, recap, game over.
 * It is a pure view — the scene hands it a model, it renders strings and
 * reports clicks back as named actions. Sections only touch the DOM when
 * their HTML actually changes, so buttons never vanish mid-click.
 */
import { SELECTABLE } from "../../shared/src/content/weapons";
import type { OverMsg, Phase } from "../../shared/src/protocol";
import type { Plan } from "../../shared/src/sim";
import { THEME, weaponSkin } from "../../shared/src/theme";
import { weaponIcon } from "./draw";

export interface UiPlayer {
  id: string;
  name: string;
  slot: number;
  hp: number;
  alive: boolean;
  inMatch: boolean;
  ready: boolean;
  connected: boolean;
  locked: boolean;
  bot: boolean;
  host: boolean;
  me: boolean;
}

export interface RecapLine {
  cls: string;
  html: string;
}

export interface UiModel {
  phase: Phase;
  round: number;
  maxRounds: number;
  players: UiPlayer[];
  me?: UiPlayer;
  status: string;
  /** PLAN */
  slots: (Plan | null)[];
  active: number;
  ammo: Record<string, number>;
  /** MOVE: 0..1 spoon energy */
  dig: number;
  recap: RecapLine[];
  reveal: { slot: number; name: string; w: (string | null)[] }[];
  over?: OverMsg;
  teaWarn: boolean;
  maxHp: number;
  muted: boolean;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;
export const glazeCss = (slot: number) => hex(THEME.glazes[((slot % 8) + 8) % 8].body);
const W = THEME.words;

export class Ui {
  onAct: (act: string, arg: string) => void = () => undefined;
  private root: HTMLElement;
  private sections = new Map<string, { el: HTMLElement; html: string }>();
  private timerFill!: HTMLElement;
  private timerNum!: HTMLElement;

  constructor() {
    this.root = document.getElementById("ui")!;
    const st = document.documentElement.style;
    for (const [k, v] of Object.entries(THEME.ui)) st.setProperty(`--${k}`, v);
    st.setProperty("--display", THEME.font.display);
    st.setProperty("--body", THEME.font.body);
    this.root.innerHTML = `
      <div id="top"><div id="phasebox"><div id="phasename"></div><div id="timer"><i></i></div><span id="timernum"></span></div><div id="roster"></div></div>
      <div id="callouts"></div><div id="center"></div><div id="side"></div><div id="bottom"></div>
      <div id="corner"></div><div id="status"></div>`;
    for (const id of ["phasename", "roster", "center", "side", "bottom", "corner", "status"]) {
      this.sections.set(id, { el: document.getElementById(id)!, html: "" });
    }
    this.timerFill = this.root.querySelector("#timer i")!;
    this.timerNum = document.getElementById("timernum")!;
    this.root.addEventListener("click", (e) => {
      const t = (e.target as HTMLElement).closest("[data-act]") as HTMLElement | null;
      if (!t || t.hasAttribute("disabled")) return;
      e.stopPropagation();
      this.onAct(t.dataset.act!, t.dataset.arg ?? "");
    });
    // Clicks on the UI must never reach the canvas underneath.
    for (const ev of ["pointerdown", "mousedown", "wheel", "contextmenu"]) {
      this.root.addEventListener(ev, (e) => {
        if ((e.target as HTMLElement).closest(".panel,button,.slot,#roster")) e.stopPropagation();
      });
    }
  }

  private put(id: string, html: string): void {
    const s = this.sections.get(id)!;
    if (s.html === html) return;
    s.html = html;
    s.el.innerHTML = html;
  }

  setTimer(frac: number, secs: number, urgent: boolean): void {
    this.timerFill.style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
    this.timerFill.className = urgent ? "urgent" : "";
    this.timerNum.textContent = secs > 0 ? String(secs) : "";
  }

  callout(text: string, cls = ""): void {
    const box = document.getElementById("callouts")!;
    while (box.children.length > 2) box.firstElementChild!.remove();
    const d = document.createElement("div");
    d.className = `callout ${cls}`;
    d.textContent = text;
    box.appendChild(d);
    setTimeout(() => d.remove(), 1900);
  }

  render(m: UiModel): void {
    document.body.dataset.phase = m.phase;
    const inGame = m.phase !== "LOBBY" && m.phase !== "COUNTDOWN";
    this.put(
      "phasename",
      inGame
        ? `<b>${THEME.phase[m.phase]}</b><span>${m.phase === "GAME_OVER" ? "" : `Round ${m.round}/${m.maxRounds}`}</span>`
        : "",
    );
    document.getElementById("phasebox")!.style.display = inGame ? "" : "none";
    this.put("roster", inGame ? this.roster(m) : "");
    this.put("status", m.status ? `<div class="pill">${esc(m.status)}</div>` : "");
    this.put("corner", `<button data-act="mute" title="Mute (M)">${m.muted ? "♪̸" : "♪"}</button>`);

    let center = "";
    let bottom = "";
    let side = "";
    if (m.phase === "LOBBY" || m.phase === "COUNTDOWN") center = this.lobby(m);
    else if (m.phase === "GAME_OVER") center = this.over(m);
    else if (m.phase === "MOVE") bottom = this.move(m);
    else if (m.phase === "PLAN") bottom = this.plan(m);
    else if (m.phase === "RESOLVE") bottom = "";
    else if (m.phase === "AFTERMATH") side = this.recap(m);
    this.put("center", center);
    this.put("bottom", bottom);
    this.put("side", side);
  }

  private roster(m: UiModel): string {
    return m.players
      .filter((p) => p.inMatch)
      .sort((a, b) => a.slot - b.slot)
      .map((p) => {
        const mark = !p.alive ? "✕" : !p.connected && !p.bot ? "…" : m.phase === "PLAN" && p.locked ? "✓" : "";
        return `<div class="rp${p.alive ? "" : " dead"}${p.me ? " me" : ""}">
          <i style="background:${glazeCss(p.slot)}"></i><span class="nm">${esc(p.name)}</span>
          <span class="bar"><b style="width:${Math.max(0, Math.min(100, (p.hp / m.maxHp) * 100))}%"></b></span><em>${mark}</em></div>`;
      })
      .join("");
  }

  private lobby(m: UiModel): string {
    const seats = m.players.filter((p) => p.slot >= 0).sort((a, b) => a.slot - b.slot);
    const cards = seats
      .map(
        (p) => `<div class="card${p.ready ? " ready" : ""}${p.me ? " me" : ""}" style="--g:${glazeCss(p.slot)}">
        <i></i><b>${esc(p.name)}</b><span>${p.bot ? "bot" : !p.connected ? "away…" : p.ready ? W.ready : W.notReady}${p.host ? " · host" : ""}</span></div>`,
      )
      .join("");
    const me = m.me;
    const count = m.phase === "COUNTDOWN";
    return `<div class="panel lobby">
      <h1>${THEME.title}</h1><p class="tag">${THEME.tagline}</p>
      <div class="cards">${cards}</div>
      <div class="how">
        <div><b>1 · ${THEME.phase.MOVE}</b>Everyone moves at once. <kbd>A</kbd><kbd>D</kbd> walk, <kbd>W</kbd> hop, hold <kbd>Shift</kbd> to dig.</div>
        <div><b>2 · ${THEME.phase.PLAN}</b>Secretly queue two lumps: aim with the mouse, pick sweets with <kbd>1</kbd>–<kbd>7</kbd>.</div>
        <div><b>3 · ${THEME.phase.RESOLVE}</b>Everything goes off at once. Last pot standing ${W.winner}.</div>
      </div>
      <div class="row">
        ${
          count
            ? `<div class="count">${THEME.phase.COUNTDOWN}…</div>`
            : me && me.slot >= 0
              ? `<button class="big${me.ready ? " on" : ""}" data-act="ready">${me.ready ? "Ready ✓" : "I'm ready"}</button>`
              : `<div class="count">Table is full — you are ${W.spectator}</div>`
        }
        ${me?.host && !count ? `<button data-act="bot" data-arg="1"${seats.length >= 8 ? " disabled" : ""}>+ ${W.addBot}</button><button data-act="bot" data-arg="-1"${seats.some((p) => p.bot) ? "" : " disabled"}>− ${W.removeBot}</button>` : ""}
      </div>
      <p class="small">${seats.filter((p) => !p.bot).length < 2 && !seats.some((p) => p.bot) ? "On your own? Invite a bot, or ready up for target practice." : "The match starts when every guest is ready."}</p>
    </div>`;
  }

  private move(m: UiModel): string {
    if (!m.me?.inMatch) return `<div class="panel hint">You are ${W.spectator}. ${m.me && m.me.slot >= 0 ? "A pot is yours next round." : ""}</div>`;
    if (!m.me.alive) return `<div class="panel hint">Your pot is ${W.dead}. Enjoy the show.</div>`;
    return `<div class="panel hint"><span><kbd>A</kbd><kbd>D</kbd> walk</span><span><kbd>W</kbd> hop</span><span><kbd>Shift</kbd>+direction dig</span>
      <span class="spoon">${W.dig}<span class="bar"><b style="width:${Math.round(m.dig * 100)}%"></b></span></span></div>`;
  }

  private plan(m: UiModel): string {
    const me = m.me;
    if (!me?.inMatch || !me.alive) return `<div class="panel hint">${me?.inMatch ? `Your pot is ${W.dead}.` : `You are ${W.spectator}.`} The others are scheming…</div>`;
    if (me.locked) {
      const waiting = m.players.filter((p) => p.inMatch && p.alive && !p.locked && (p.bot || p.connected)).length;
      return `<div class="panel hint locked"><b>${W.locked}</b> ${waiting ? `waiting for ${waiting} more ${waiting === 1 ? W.pot : W.pot + "s"}` : "here it comes"}</div>`;
    }
    const used: Record<string, number> = {};
    for (const s of m.slots) if (s) used[s.w] = (used[s.w] ?? 0) + 1;
    const slots = m.slots
      .map((s, i) => {
        const skin = s ? weaponSkin(s.w) : null;
        return `<div class="slot${i === m.active ? " active" : ""}${s ? "" : " empty"}" data-act="slot" data-arg="${i}">
          <small>${W.lump} ${i + 1}${i ? " · 1.7s later" : ""}</small>
          ${s && skin ? `<img src="${weaponIcon(s.w)}" alt=""><b>${skin.name}</b><span class="x" data-act="clear" data-arg="${i}" title="Clear (R)">✕</span>` : `<b class="none">${i ? "optional" : "nothing"}</b>`}
        </div>`;
      })
      .join("");
    const cur = m.slots[m.active];
    const tray = SELECTABLE.map((w, i) => {
      const skin = weaponSkin(w.id);
      const left = w.ammo < 0 ? -1 : (m.ammo[w.id] ?? 0) - (used[w.id] ?? 0) + (cur?.w === w.id ? 1 : 0);
      return `<button class="wpn${cur?.w === w.id ? " on" : ""}" data-act="weapon" data-arg="${w.id}"${left === 0 ? " disabled" : ""} title="${esc(skin.name)} — ${esc(skin.blurb)}">
        <kbd>${i + 1}</kbd><img src="${weaponIcon(w.id)}" alt=""><span>${skin.name}</span><em>${left < 0 ? "∞" : left}</em></button>`;
    }).join("");
    return `<div class="panel plan">
      <div class="slots">${slots}</div>
      <div class="mid"><div class="tray">${tray}</div><div class="blurb">${cur ? esc(weaponSkin(cur.w).blurb) : "Pick a sweet for this lump, or leave it empty."} <span>Click to pin your aim · <kbd>Tab</kbd> switch lump</span></div></div>
      <button class="big lock" data-act="lock">${W.lock}<small>Enter</small></button>
    </div>`;
  }

  private recap(m: UiModel): string {
    const reveal = m.reveal
      .map(
        (r) => `<div class="rv"><i style="background:${glazeCss(r.slot)}"></i><span>${esc(r.name)}</span>${r.w
          .map((w) => (w ? `<img src="${weaponIcon(w)}" title="${esc(weaponSkin(w).name)}" alt="">` : `<u></u>`))
          .join("")}</div>`,
      )
      .join("");
    return `<div class="panel recap"><h2>${THEME.phase.AFTERMATH}</h2>
      ${m.recap.map((l) => `<p class="${l.cls}">${l.html}</p>`).join("") || "<p>Not a scratch on anyone.</p>"}
      <div class="reveal">${reveal}</div>
      ${m.teaWarn ? `<p class="warn">☕ ${W.tea} — get to higher ground.</p>` : ""}</div>`;
  }

  private over(m: UiModel): string {
    const o = m.over;
    if (!o) return "";
    const win = o.rows.find((r) => r.slot === o.winner);
    const rows = o.rows
      .map(
        (r, i) => `<tr class="${r.slot === o.winner ? "win" : ""}"><td>${i + 1}</td><td><i style="background:${glazeCss(r.slot)}"></i>${esc(r.name)}</td>
        <td>${r.alive ? `${r.hp} ${W.hp}` : W.dead}</td><td>${r.dealt}</td><td>${r.kills}</td></tr>`,
      )
      .join("");
    const awards = o.awards
      .map((a) => {
        const r = o.rows.find((x) => x.slot === a.slot);
        return r ? `<div class="award"><i style="background:${glazeCss(a.slot)}"></i><b>${esc(r.name)}</b><span>${(W.awards as Record<string, string>)[a.key] ?? a.key}</span></div>` : "";
      })
      .join("");
    return `<div class="panel over">
      <h1 style="${win ? `color:${glazeCss(win.slot)}` : ""}">${win ? `${esc(win.name)} ${W.winner}!` : W.draw}</h1>
      <p class="tag">${OVER_TAG[o.reason] ?? OVER_TAG.draw}</p>
      <table><tr><th></th><th></th><th></th><th>crumbs</th><th>pots</th></tr>${rows}</table>
      <div class="awards">${awards}</div>
      <p class="small">Back to the ${THEME.phase.LOBBY.toLowerCase()} shortly…</p></div>`;
  }
}

const OVER_TAG: Record<string, string> = {
  last: "Last pot standing.",
  outlasted: "Everyone shattered in the same Pour. This one held out longest.",
  rounds: "Most tea left when the party ended.",
  draw: "Everybody lost. Splendid.",
  abandoned: "The party broke up.",
};

export function nameTag(slot: number, name: string): string {
  return `<b style="color:${glazeCss(slot)}">${esc(name)}</b>`;
}
