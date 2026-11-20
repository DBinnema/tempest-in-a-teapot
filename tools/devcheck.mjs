// Smoke test for `npm run dev`: two tabs on the Vite dev server reach a match.
import { chromium } from "playwright-core";
let browser;
for (const channel of ["chrome", "msedge"]) { try { browser = await chromium.launch({ channel }); break; } catch {} }
const errors = [];
const open = async (n) => { const p = await browser.newPage(); p.on("pageerror", (e) => errors.push(e.message)); p.on("console", (m) => m.type() === "error" && errors.push(m.text())); await p.goto(`http://localhost:5173/?room=dev&name=${n}`); return p; };
const a = await open("One"), b = await open("Two");
await a.waitForSelector('[data-act="ready"]', { timeout: 30000 });
await b.waitForSelector('[data-act="ready"]', { timeout: 30000 });
await a.click('[data-act="ready"]'); await b.click('[data-act="ready"]');
let d = {};
for (let i = 0; i < 100 && d.phase !== "MOVE"; i++) { await new Promise((r) => setTimeout(r, 100)); d = await a.evaluate(() => window.__game.scene.debug()); }
console.log("tab A:", JSON.stringify(d)); console.log("tab B:", JSON.stringify(await b.evaluate(() => window.__game.scene.debug())));
console.log(errors.length ? "errors:\n" + errors.join("\n") : "no console errors");
await browser.close();
