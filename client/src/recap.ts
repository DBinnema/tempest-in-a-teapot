/**
 * Turns a RESOLVE event log into the handful of sentences shown in the
 * aftermath: who broke whom, who hurt whom, and what never got to happen.
 */
import type { SimEvent } from "../../shared/src/sim";
import { weaponSkin } from "../../shared/src/theme";
import type { RecapLine } from "./ui";

export function buildRecap(events: SimEvent[], tag: (id: number) => string): RecapLine[] {
  const out: RecapLine[] = [];
  const dead = new Set<number>();
  for (const e of events) {
    if (e.k !== "death") continue;
    const v = e.v!;
    const a = e.a ?? -1;
    dead.add(v);
    let how: string;
    if (e.c === "tea") how = "dissolved in the tea";
    else if (e.c === "crush") how = a >= 0 && a !== v ? `was crushed by cake ${tag(a)} brought down` : "was crushed by falling cake";
    else if (e.c === "fall") how = a >= 0 && a !== v ? `was knocked to pieces by ${tag(a)}` : "fell to pieces";
    else if (a === v) how = `shattered on their own ${weaponSkin(e.w ?? "").name}`;
    else if (e.w === "shatter") how = `was caught in ${a >= 0 ? tag(a) + "'s" : "a"} chain reaction`;
    else how = a >= 0 ? `was shattered by ${tag(a)}'s ${weaponSkin(e.w ?? "").name}` : "shattered";
    out.push({ cls: "kill", html: `✕ ${tag(v)} ${how}` });
  }

  // Add up damage per (attacker, victim) so three sprinkles read as one line.
  const sums = new Map<string, { a: number; v: number; n: number; c: string }>();
  for (const e of events) {
    if (e.k !== "dmg") continue;
    const a = e.a ?? -1;
    const key = `${a}>${e.v}>${a < 0 ? e.c : ""}`;
    const s = sums.get(key) ?? { a, v: e.v!, n: 0, c: e.c ?? "" };
    s.n += e.n ?? 0;
    sums.set(key, s);
  }
  const hits = [...sums.values()].filter((s) => !dead.has(s.v) || s.a !== s.v).sort((x, y) => y.n - x.n);
  for (const s of hits.slice(0, 5)) {
    if (s.a === s.v) out.push({ cls: "", html: `${tag(s.a)} hurt themselves <b>−${s.n}</b>` });
    else if (s.a >= 0) out.push({ cls: "", html: `${tag(s.a)} → ${tag(s.v)} <b>−${s.n}</b>` });
    else out.push({ cls: "", html: `${tag(s.v)} <b>−${s.n}</b> (${s.c === "tea" ? "scalded" : s.c === "crush" ? "falling cake" : "a fall"})` });
  }
  if (hits.length > 5) out.push({ cls: "dim", html: `…and ${hits.length - 5} more scuffles` });

  const count = (k: string) => events.filter((e) => e.k === k).length;
  const extras: string[] = [];
  if (count("clash")) extras.push(`${count("clash")} mid-air clash${count("clash") > 1 ? "es" : ""}`);
  if (count("reflect")) extras.push(`${count("reflect")} shot${count("reflect") > 1 ? "s" : ""} returned to sender`);
  if (count("block")) extras.push(`${count("block")} blast${count("block") > 1 ? "s" : ""} shrugged off under glass`);
  const fizz = events.filter((e) => e.k === "fizzle").map((e) => tag(e.a!));
  if (fizz.length) extras.push(`${[...new Set(fizz)].join(", ")} never got to pour a second lump`);
  if (extras.length) out.push({ cls: "dim", html: extras.join(" · ") });
  return out;
}
