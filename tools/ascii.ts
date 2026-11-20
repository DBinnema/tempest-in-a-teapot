// Dev aid: print a terrain seed as ASCII (every 2nd row/col). `npx tsx tools/ascii.ts 123`
import { generateTerrain } from "../shared/src/terrain";
const seed = Number(process.argv[2] ?? 1);
const g = generateTerrain(seed);
const ch = " .c#jX=~d";
for (let y = 0; y < g.h; y += 3) {
  let line = "";
  for (let x = 0; x < g.w; x += 2) line += ch[g.cells[y * g.w + x]];
  console.log(line);
}
