/**
 * Terrain materials. Mechanics only — colours and names live in theme.ts
 * keyed by `key`. Add a material by appending here (ids must stay stable,
 * they are what the grid stores) and giving it a look in the theme.
 */
export interface MaterialDef {
  id: number;
  key: string;
  /** Blast resistance x10. 10 = carved to the full blast radius, 16 = only the
   *  inner 62%. 0 = indestructible. */
  tough: number;
  /** Projectiles and pots bounce off it instead of stopping. */
  bouncy: boolean;
  /** Anchors hold terrain up. Anything not connected to an anchor falls. */
  anchor: boolean;
  /** Dig-energy cost per cell when a pot digs through it (0 = undiggable). */
  digCost: number;
}

export const AIR = 0;
export const SPONGE = 1;
export const CREAM = 2;
export const FUDGE = 3;
export const JELLY = 4;
export const CANDY = 5;
export const PLATE = 6;
export const ICING = 7;
export const DOUGH = 8;

export const MATERIALS: MaterialDef[] = [
  { id: AIR, key: "air", tough: 0, bouncy: false, anchor: false, digCost: 0 },
  { id: SPONGE, key: "sponge", tough: 10, bouncy: false, anchor: false, digCost: 1 },
  { id: CREAM, key: "cream", tough: 8, bouncy: false, anchor: false, digCost: 1 },
  { id: FUDGE, key: "fudge", tough: 16, bouncy: false, anchor: false, digCost: 3 },
  { id: JELLY, key: "jelly", tough: 12, bouncy: true, anchor: false, digCost: 2 },
  { id: CANDY, key: "candy", tough: 0, bouncy: false, anchor: true, digCost: 0 },
  { id: PLATE, key: "plate", tough: 0, bouncy: false, anchor: true, digCost: 0 },
  { id: ICING, key: "icing", tough: 9, bouncy: false, anchor: false, digCost: 1 },
  { id: DOUGH, key: "dough", tough: 11, bouncy: false, anchor: false, digCost: 1 },
];
