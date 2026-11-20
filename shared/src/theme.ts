/**
 * THE SKIN. Every name, colour, procedural-art parameter and sound parameter
 * lives here; nothing else in the project hard-codes a look. To reskin the
 * game, copy this file, change the values, and export it as THEME.
 *
 * Current skin: "Tempest in a Teapot" — porcelain teapots lobbing sweets at
 * each other across a giant layer cake while the tea slowly rises.
 */

export interface Glaze {
  name: string;
  body: number;
  dark: number;
  light: number;
}

export interface WeaponSkin {
  name: string;
  blurb: string;
  /** which procedural icon/projectile drawing to use */
  art: "cube" | "ball" | "star" | "screw" | "blob" | "puff" | "dome";
  color: number;
  /** key into THEME.sound for launch */
  fire: string;
}

export const THEME = {
  title: "Tempest in a Teapot",
  tagline: "simultaneous teatime artillery",

  phase: {
    LOBBY: "Tea Party",
    COUNTDOWN: "Kettle's On",
    MOVE: "Scurry!",
    PLAN: "Steep",
    RESOLVE: "Pour!",
    AFTERMATH: "Crumbs",
    GAME_OVER: "Last Orders",
  },
  phaseHint: {
    MOVE: "Everyone moves at once. Find a perch, a tunnel, an angle.",
    PLAN: "One lump or two? Queue up to two actions in secret.",
    RESOLVE: "Everything goes off at once.",
    AFTERMATH: "Who did what to whom.",
  },
  words: {
    lump: "Lump",
    lumps: ["One lump", "Two lumps"],
    lock: "Lock in",
    locked: "Steeping…",
    ready: "Ready",
    notReady: "Not ready",
    addBot: "Invite a bot",
    removeBot: "Dismiss a bot",
    pot: "pot",
    hp: "tea",
    dig: "Spoon",
    tea: "The tea is rising",
    dead: "in pieces",
    spectator: "watching",
    winner: "takes the cake",
    draw: "Nobody takes the cake",
    callouts: {
      clash: "CLASH!",
      reflect: "RETURNED!",
      kill: "SHATTERED!",
      final: "LAST POT STANDING",
      own: "OWN GOAL",
      fizzle: "…never got to pour",
      crush: "CRUSHED!",
      buried: "BURIED",
      double: "DOUBLE!",
      scald: "STEEPED",
      chain: "CHAIN REACTION",
    },
    awards: {
      crumbs: "Most Crumbs (damage dealt)",
      shatter: "Pot Breaker (most kills)",
      mole: "Sugar Mole (most digging)",
      own: "Butterfingers (hurt themselves most)",
      untouched: "Not a Chip (least damage taken)",
    },
  },

  /** System fonts only: Discord's CSP blocks web fonts. */
  font: {
    display: "'Cooper Black','Rockwell Extra Bold','Bookman Old Style',Georgia,'Times New Roman',serif",
    body: "Georgia,'Palatino Linotype','Book Antiqua',Palatino,serif",
  },

  ui: {
    ink: "#3b1f2b",
    paper: "#fff4e0",
    paperDim: "#f6e2c2",
    accent: "#e8425a",
    accent2: "#2fb8b0",
    gold: "#f2b632",
    shadow: "rgba(59,31,43,0.35)",
  },

  sky: {
    top: 0xbfe8e0,
    bottom: 0xfde7c7,
    /** gingham check drawn over the gradient */
    check: 0xffffff,
    checkAlpha: 0.16,
    checkSize: 56,
    /** far-away crockery silhouettes */
    silhouette: 0x9fd3cc,
    silhouetteAlpha: 0.45,
  },

  ink: 0x3b1f2b,

  /** Terrain materials, keyed like shared/content/materials.ts. RGB triples. */
  materials: {
    sponge: {
      /** one colour per cake layer, cycled with depth */
      flavours: [
        [243, 209, 140],
        [240, 163, 168],
        [188, 214, 140],
        [222, 170, 110],
      ],
      speckle: 22,
      holes: 0.06,
    },
    cream: { color: [255, 247, 234], speckle: 6 },
    fudge: { color: [106, 59, 42], speckle: 14, chips: 0.05 },
    jelly: { color: [232, 80, 122], shine: [255, 190, 205], speckle: 4 },
    candy: { a: [255, 255, 255], b: [232, 66, 90], stripe: 5 },
    plate: { a: [223, 233, 245], b: [109, 143, 208], stripe: 9 },
    icing: {
      color: [255, 159, 181],
      sprinkles: [
        [255, 255, 255],
        [242, 182, 50],
        [47, 184, 176],
        [91, 110, 225],
      ],
      sprinkleRate: 0.08,
    },
    dough: { color: [247, 230, 191], speckle: 8 },
    outline: [59, 31, 43],
    scorch: [84, 46, 30],
    /** layer height in cells for the sponge flavours */
    layer: 18,
  },

  tea: { color: 0xc8792b, alpha: 0.5, foam: 0xffe9c4, steam: 0xffffff },

  glazes: [
    { name: "Cobalt", body: 0x5b6ee1, dark: 0x3a469c, light: 0xaeb8ff },
    { name: "Rosehip", body: 0xe8425a, dark: 0xa3263b, light: 0xffa3b0 },
    { name: "Matcha", body: 0x58b368, dark: 0x2f7a40, light: 0xb4e8ba },
    { name: "Chamomile", body: 0xf2b632, dark: 0xb37b12, light: 0xffe49a },
    { name: "Lavender", body: 0xa66bd4, dark: 0x6d3d99, light: 0xdcc0f5 },
    { name: "Marmalade", body: 0xf07f3c, dark: 0xad4e17, light: 0xffc39c },
    { name: "Peppermint", body: 0x2fb8b0, dark: 0x147a74, light: 0xa6ece6 },
    { name: "Hibiscus", body: 0xe86bb0, dark: 0xa33a78, light: 0xffc0e2 },
  ] as Glaze[],

  botNames: ["Sir Steepsalot", "Lady Grey", "Chai Guevara", "Brewce", "Kettle Belle", "Tea Rex", "Spout Master", "Darjeeling Dan"],

  weapons: {
    sugar: { name: "Sugar Cube", blurb: "Goes boom where it lands. Unlimited.", art: "cube", color: 0xffffff, fire: "pop" },
    jawbreaker: { name: "Jawbreaker", blurb: "Bounces and rolls. Big bang on a fuse.", art: "ball", color: 0x5b6ee1, fire: "thunk" },
    sprinkles: { name: "Sprinkle Burst", blurb: "Splits into six at the top of its arc.", art: "star", color: 0xf2b632, fire: "pop" },
    corkscrew: { name: "Corkscrew", blurb: "Bores a tunnel through cake, then pops.", art: "screw", color: 0xb9c4d6, fire: "whirr" },
    dough: { name: "Dough Ball", blurb: "Splats into a wall. Block, bridge or bury.", art: "blob", color: 0xf7e6bf, fire: "thunk" },
    steam: { name: "Steam Hop", blurb: "Launch yourself. Be somewhere else.", art: "puff", color: 0xe8f6ff, fire: "whistle" },
    cloche: { name: "Cloche", blurb: "Glass dome: shots bounce back for 3.5s.", art: "dome", color: 0xa6ece6, fire: "ting" },
    bomblet: { name: "Sprinkle", blurb: "", art: "star", color: 0xf2b632, fire: "pop" },
    shatter: { name: "Shrapnel", blurb: "", art: "cube", color: 0xffffff, fire: "pop" },
  } as Record<string, WeaponSkin>,

  fx: {
    crumbs: [0xf3d18c, 0xf0a3a8, 0xbcd68c, 0xfff7ea, 0x6a3b2a],
    smoke: 0xfff4e0,
    flash: 0xfffbe8,
    fire: [0xfff1a8, 0xf2b632, 0xf07f3c, 0xe8425a],
    porcelain: 0xffffff,
    trailAlpha: 0.55,
  },

  /**
   * WebAudio synth patches. type: oscillator shape or "noise".
   * f0 -> f1: pitch sweep in Hz over `dur` seconds. q/cut: filter for noise.
   */
  sound: {
    master: 0.5,
    pop: { type: "sine", f0: 620, f1: 180, dur: 0.16, gain: 0.5, noise: 0.25 },
    thunk: { type: "triangle", f0: 240, f1: 90, dur: 0.2, gain: 0.6, noise: 0.2 },
    whirr: { type: "sawtooth", f0: 180, f1: 520, dur: 0.35, gain: 0.25, noise: 0.05 },
    whistle: { type: "sine", f0: 900, f1: 2400, dur: 0.55, gain: 0.25, noise: 0.3 },
    ting: { type: "sine", f0: 2100, f1: 2050, dur: 0.9, gain: 0.3, noise: 0, partial: 2.76 },
    boom: { type: "sine", f0: 150, f1: 38, dur: 0.55, gain: 0.9, noise: 0.9, cut: 900 },
    splat: { type: "sine", f0: 320, f1: 70, dur: 0.22, gain: 0.5, noise: 0.6, cut: 500 },
    boing: { type: "sine", f0: 180, f1: 520, dur: 0.22, gain: 0.4, noise: 0 },
    tink: { type: "triangle", f0: 1300, f1: 900, dur: 0.07, gain: 0.25, noise: 0 },
    shatter: { type: "noise", f0: 4200, f1: 2600, dur: 0.6, gain: 0.5, noise: 1, cut: 5200 },
    thud: { type: "sine", f0: 90, f1: 40, dur: 0.4, gain: 0.9, noise: 0.5, cut: 300 },
    crack: { type: "noise", f0: 800, f1: 300, dur: 0.25, gain: 0.4, noise: 1, cut: 1400 },
    ding: { type: "sine", f0: 1760, f1: 1750, dur: 0.8, gain: 0.35, noise: 0, partial: 2.4 },
    dingHi: { type: "sine", f0: 2637, f1: 2630, dur: 1.2, gain: 0.4, noise: 0, partial: 2.4 },
    tick: { type: "triangle", f0: 1000, f1: 800, dur: 0.03, gain: 0.15, noise: 0 },
    click: { type: "triangle", f0: 700, f1: 500, dur: 0.05, gain: 0.25, noise: 0 },
    lock: { type: "sine", f0: 523, f1: 1046, dur: 0.18, gain: 0.3, noise: 0 },
    hurt: { type: "square", f0: 300, f1: 140, dur: 0.12, gain: 0.18, noise: 0.2 },
    dig: { type: "noise", f0: 900, f1: 500, dur: 0.07, gain: 0.18, noise: 1, cut: 1200 },
    fizzle: { type: "sawtooth", f0: 400, f1: 80, dur: 0.5, gain: 0.15, noise: 0.2 },
    sizzle: { type: "noise", f0: 3000, f1: 6000, dur: 0.5, gain: 0.25, noise: 1, cut: 7000 },
    fanfare: { type: "triangle", f0: 523, f1: 523, dur: 0.2, gain: 0.35, noise: 0 },
    /** music-box loop: scale degrees (semitones from root), 3/4 time */
    music: {
      root: 392,
      bpm: 132,
      gain: 0.07,
      pattern: [0, 7, 12, 4, 7, 12, 5, 9, 12, 4, 7, 11, 0, 7, 16, 4, 7, 14, 5, 9, 12, 2, 7, 11],
    },
  } as Record<string, any>,
};

export type Theme = typeof THEME;

export function weaponSkin(id: string): WeaponSkin {
  return THEME.weapons[id] ?? { name: id, blurb: "", art: "cube", color: 0xffffff, fire: "pop" };
}
