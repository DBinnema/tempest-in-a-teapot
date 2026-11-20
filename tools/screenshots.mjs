// Drives a real match in a real browser and saves a screenshot of every
// phase into ./shots. Uses the system Chrome/Edge through playwright-core,
// so nothing has to be downloaded. Run `npm run build` first.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const PORT = 2599;
const OUT = "shots";
const ROUNDS = Number(process.env.SHOT_ROUNDS || 3);
const mismatches = [];
const HP = Number(process.env.SHOT_HP || 45);
mkdirSync(OUT, { recursive: true });

const server = spawn(process.execPath, ["server/dist/server/src/index.js"], {
  env: { ...process.env, PORT: String(PORT), TEAPOT_TEST: "1" },
  stdio: ["ignore", "inherit", "inherit"],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(1200);

let browser;
for (const channel of ["chrome", "msedge"]) {
  try {
    browser = await chromium.launch({ channel, args: ["--autoplay-policy=no-user-gesture-required"] });
    break;
  } catch {
    /* try the next one */
  }
}
if (!browser) throw new Error("No Chrome or Edge found");

const errors = [];
async function open(name, w, h) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  page.on("console", (m) => m.type() === "error" && errors.push(`${name}: ${m.text()}`));
  page.on("pageerror", (e) => errors.push(`${name}: ${e.stack || e.message}`));
  await page.goto(`http://localhost:${PORT}/?room=shots&name=${name}&hp=${HP}&rounds=${ROUNDS}`);
  return page;
}
const dbg = (p) => p.evaluate(() => window.__game?.scene?.debug?.() ?? {});
async function waitPhase(p, phase, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const d = await dbg(p);
    if (d.phase === phase) return d;
    await sleep(60);
  }
  throw new Error(`timed out waiting for ${phase}; at ${JSON.stringify(await dbg(p))}`);
}
const shot = (p, name) => p.screenshot({ path: `${OUT}/${name}.png` });

try {
  const a = await open("Earl", 1280, 720);
  const b = await open("Chai%20%3Cb%3E", 720, 440); // small panel + a name that needs sanitising
  await sleep(1500);
  await a.click('[data-act="bot"][data-arg="1"]');
  await a.click('[data-act="bot"][data-arg="1"]');
  await sleep(300);
  await shot(a, "01-lobby");
  await shot(b, "01-lobby-small");
  await a.click('[data-act="ready"]');
  await b.click('[data-act="ready"]');

  for (let round = 1; round <= ROUNDS + 1; round++) {
    const first = await Promise.race([waitPhase(a, "MOVE"), waitPhase(a, "GAME_OVER")]);
    if (first.phase === "GAME_OVER") break;
    const tag = `r${round}`;
    // MOVE: drive, hop, then dig sideways
    await a.mouse.click(640, 300);
    await a.keyboard.down(round % 2 ? "d" : "a");
    await sleep(1500);
    await a.keyboard.press("w");
    await sleep(1200);
    await a.keyboard.down("Shift");
    await sleep(2500);
    await shot(a, `02-move-${tag}`);
    if (round === 1) await shot(b, "02-move-small");
    await a.keyboard.up("Shift");
    await a.keyboard.up(round % 2 ? "d" : "a");

    await waitPhase(a, "PLAN");
    await sleep(700);
    // PLAN: aim lump one with the mouse, pin it, pick a second lump, aim it
    await a.mouse.move(820, 180);
    await a.mouse.click(820, 180);
    await a.keyboard.press(round === 1 ? "2" : round === 2 ? "4" : "3");
    await a.mouse.move(420, 200);
    await sleep(500);
    await shot(a, `03-plan-${tag}`);
    await b.mouse.move(200, 120);
    await b.mouse.click(200, 120);
    await b.keyboard.press("3");
    await b.mouse.move(500, 100);
    await sleep(400);
    if (round === 1) await shot(b, "03-plan-small");
    await a.mouse.click(420, 200);
    await a.keyboard.press("Enter");
    await sleep(300);
    if (round === 1) await shot(a, "03-plan-locked");
    await b.keyboard.press("Enter");

    await waitPhase(a, "RESOLVE");
    await sleep(1500);
    await shot(a, `04-resolve-${tag}-0reveal`);
    for (let i = 1; i <= 14; i++) {
      await sleep(650);
      const d = await dbg(a);
      if (d.phase !== "RESOLVE") break;
      await shot(a, `04-resolve-${tag}-${String(i).padStart(2, "0")}`);
      if (round === 1 && i === 4) await shot(b, "04-resolve-small");
    }
    const after = await Promise.race([waitPhase(a, "AFTERMATH"), waitPhase(a, "GAME_OVER")]);
    await sleep(900);
    if (after.phase === "AFTERMATH") {
      await shot(a, `05-aftermath-${tag}`);
      if (round === 1) await shot(b, "05-aftermath-small");
    }
    const da = await dbg(a);
    const db = await dbg(b);
    console.log(tag, JSON.stringify(da), JSON.stringify(db));
    if (da.hash !== db.hash) mismatches.push(tag);
  }
  await waitPhase(a, "GAME_OVER", 90000);
  await sleep(1200);
  await shot(a, "06-gameover");
  await shot(b, "06-gameover-small");
  await waitPhase(a, "LOBBY", 30000);
  await sleep(500);
  await shot(a, "07-back-in-lobby");
  // (the lobby's backdrop cake is random per client, so compare in-match hashes only)
  console.log(mismatches.length ? `WORLD HASH MISMATCH after ${mismatches.join(", ")}` : `both clients agreed on the world after every round`);
} catch (e) {
  console.error("FAILED:", e);
  process.exitCode = 1;
} finally {
  console.log(errors.length ? `console errors:\n${errors.join("\n")}` : "no console errors");
  await browser.close();
  server.kill();
}
