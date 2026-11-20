# Tempest in a Teapot — design notes

What shipped, and why each call was made. The brief said to decide rather
than ask; these are the decisions.

## Theme

Porcelain teapots lobbing sweets across a giant layer cake at a tea party
that has got out of hand. Chosen because it re-reads every genre staple in a
friendlier key (shells → sugar cubes, shrapnel → sprinkles, rubble → crumbs,
death → a pot shattering), and because a layer cake is *naturally* strata of
different materials with jelly pockets, candy struts and hard fudge — the
terrain rules fall out of the fiction.

| Brief  | In the game | |
| ------ | ----------- | - |
| MOVE   | **Scurry** (12 s) | everybody drives at once |
| PLAN   | **Steep** (26 s)  | secret planning, world frozen |
| RESOLVE| **Pour**          | everything goes off together |
| —      | **Crumbs** (7 s)  | recap, then the next round |

All names, words, colours, fonts and sound patches live in
`shared/src/theme.ts`; mechanics live in `shared/src/content/`. Nothing in the
sim or server mentions tea. Art is drawn with Phaser graphics and canvas
textures, sound is WebAudio synthesis, fonts are system serif stacks: the
bundle makes no request to anything but its own origin.

## The loop

- **Lobby.** Everyone readies up (2+ pots; the host — earliest connected
  human — may add bots, so one person can play). 3 s countdown.
- **Scurry.** Real-time, server-authoritative, client-predicted. Walk, hop,
  dig. Digging spends a "spoon" gauge that refills each round, so you can
  tunnel about a third of the screen per round, not escape forever.
- **Steep.** Each pot queues **two lumps**. Lump one fires at tick 0, lump
  two exactly 100 ticks (1.67 s) later from wherever the pot is *then*. Two
  was chosen over one (no combos) and three (planning takes too long with 8
  players): it is the smallest number that allows hop-then-shoot,
  drill-then-follow-up and shield-then-retaliate. A pot that is shattered
  before beat two does not get its second lump — reading who will die first
  matters. When every living player has locked in, the timer drops to 0.9 s.
  Unlocked plans are still sent as you edit, so running out of time fires
  what you were looking at instead of nothing.
- **Pour.** See below.
- **Crumbs.** Recap panel: kills, summed damage per attacker/victim pair,
  clashes, reflected shots, lumps that never fired, and everyone's revealed
  plan. A warning if the tea rises next round.
- **End.** Last pot standing; or, if every remaining pot shatters in the
  same Pour, the one that broke *last* (same tick: a draw); or most tea left
  after 12 rounds. Results table plus awards, 14 s, then back to the same lobby with
  the same people.

**Anti-stall.** From round 3 the tea rises (6, 7, 8 … rows a round,
accelerating) and scalds (25) anything standing in it at the end of a Pour.
The map shrinks from the bottom, tunnels flood, and round 12 is a hard cap.
No match can run forever.

**Pacing, measured.** `tools/balance.ts` plays whole bot matches headless
(real terrain, physics, bots, sim and director) and reports rounds, endings,
Pour length and damage sources. The first version of the rules measured
10.4 rounds per match with 10% ending at the cap and 12% draws, and a
quarter of all damage was self-inflicted. After this pass (tea from round 3,
accelerating; cap 12; bots that refuse self-harm; the latest-shattering
tie-break), 60 four-pot matches gave a median of 10 rounds and about 9
minutes at full timers; roughly 75% end with a last pot standing, 5–10%
are decided by the tie-break or the cap each, and self-damage is under 10%.
Bot-only matches overstate tea deaths (bots wander rather than climb), so
humans should see the tea as a squeeze more than a killer.

## The Pour (RESOLVE)

The key observation: the server finishes the whole simulation before anyone
sees a frame, and the client can do the same. So the presentation is not a
live feed but a **directed replay of a known outcome**.

1. `shared/src/sim.ts` runs the round at a fixed 60 Hz in integer
   fixed-point and emits an event log (fire, bounce, boom, dmg, death,
   clash, reflect, crack, thud …).
2. `shared/src/director.ts` turns the event log into a timeline: per-tick
   durations and hold frames. It is a pure function shared by both sides, so
   the server knows exactly how long the show will take and every client
   plays the same cut.
3. The client steps the *same sim* against that timeline.

Because time manipulation only changes **how long a tick is displayed**, not
what a tick computes, slow-motion and hit-stop cannot break determinism.

What the director does:

- **Reveal** (2.1 s pre-roll): every pot's two lump icons pop up above it
  with a stub arrow for direction, over three rising dings. This is the
  "oh no" beat — you see the plans collide before they do.
- **Anticipation, not reaction.** Slow-motion ramps in *before* a shattering
  (it knows the tick), and the camera is already framed on the victim when
  the shot arrives. The final kill of a match gets the deepest slow-mo.
- **Hit-stop** on damage, scaled by how hard the hit was, and on mid-air
  clashes. Particles freeze with it.
- **Camera** frames live projectiles, pots that are moving or shielded,
  recent impact sites and upcoming cues; zoom is clamped between "whole
  cake" and 2.6×, smoothed. Projectiles above the view get an edge marker.
- **Legibility.** Trails and damage numbers are tinted with the attacker's
  glaze; callouts name what happened ("Returned to sender", "Chain
  reaction", "OWN GOAL"); a jawbreaker blinks as its fuse runs down.
- **Sound** is synthesised per event with pitch tied to size; music ducks
  during the Pour.

Interactions that make simultaneous resolution worth watching:

- Shots **clash** in mid-air (opposing owners) and both detonate.
- A **Cloche** reflects shells back with their owner changed, and shrugs
  off blasts.
- Blasts cut supports; **unsupported cake falls** as rigid chunks, crushing
  what is under it and carrying what is on it. Kills by fall or crush are
  credited to whoever caused the collapse.
- A shattering pot makes a small blast of its own — **chain reactions**.
- **Dough** lands as new terrain: plug a tunnel, wall off a shot (including
  your own lump two), or bury someone.
- **Steam Hop** as lump one moves you before lump two fires; other pots
  aimed at where you were.

### Sweets (data in `shared/src/content/weapons.ts`)

| | Kind | Uses | Notes |
| - | - | - | - |
| Sugar Cube | shell | ∞ | the reliable one |
| Jawbreaker | bouncer | 3 | ricochets, big blast on a fuse |
| Sprinkle Burst | cluster | 2 | splits into six at the apex |
| Corkscrew | drill | 3 | bores a walkable tunnel, pops at the end |
| Dough Ball | builder | 3 | adds terrain |
| Steam Hop | jump | ∞ | launches the pot itself |
| Cloche | shield | 2 | reflective dome for 3.5 s |

Planning tools: the preview runs the **real sim** on a copy of the world
with only your own lumps, but shows only the **first second of each lump's
flight** (60 ticks), fading out: direction, strength, the first bounce, and
any blast or "would hit" ring inside that window. The first version showed
the whole exact path, which made any shot at a pot that didn't hop a
guaranteed hit and turned Steep into a menu of sure things. Two things
still come from the full simulation, because they are about *you*, not
your aim: your ghost where a hop lands (and where lump two fires from),
and the pulsing warning when your own plan would hurt you. Nothing
about other players' plans reaches a client before the Pour: plans are sent
to the server only, and the roster shows just a "locked" tick.

## Terrain

- 360×200 grid of material ids (sponge, cream, fudge, jelly, candy, plate,
  icing, dough), 4 px per cell. Materials differ in toughness and bounce.
- Generated from a 32-bit seed with an integer PRNG (mulberry-style,
  `Math.imul` only): layered ridged terrain, carved caves and worm tunnels,
  floating islands, candy-cane "parasol" overhangs, jelly pockets. Spawn
  spots are picked spread out on open ground.
- **Collapse rule:** after any edit, cells not connected to the plate or to
  an anchored island fall as rigid chunks. Small specks crumble instead. It
  is deterministic (scan order, integer maths) and fair: a chunk announces
  itself with a crack, only hurts once it has picked up speed, and its
  damage scales with its size up to a cap (34) — a collapse wounds, it does
  not one-shot a healthy pot.
- **Movement:** slope-limited walking (step up ≤ 2 cells), jumping, falling
  with fall damage above a safe speed, ceilings bonk, jelly bounces.
  **Buried pots:** dough blobs and falling chunks never fill a pot's own
  cells — the cake crumbles around it, leaving a pot-shaped pocket (with a
  lift-to-free fallback as a guarantee). A buried pot is never stuck: the
  spoon refills every Scurry, and Sugar Cube and Steam Hop are unlimited.
- **Sync:** clients build the grid from the seed and apply the same edits:
  dig edits are quantised circles broadcast during Scurry; Pour edits are
  not sent at all — clients re-run the sim. Each resolve carries pre/post
  hashes of grid + pots; on mismatch the client asks for an RLE snapshot
  (~a few kB) instead of carrying on wrong. RLE is also used for late
  joiners and reconnects. Terrain is never streamed per tick.

## Netcode

- Colyseus schema state holds only roster, phase and round. Everything
  else is messages (`shared/src/protocol.ts`).
- Scurry: client sends `[seq, inputBits]` at 30 Hz; server steps two 60 Hz
  ticks per input, broadcasts 30 Hz snapshots with the last acked seq;
  the client predicts its own pot and replays unacked inputs. Digging is
  not predicted (server edits arrive within a frame or two).
- Validation: wrong phase, wrong owner, non-integers, stale seq, oversized
  queues, unknown weapons, spent ammo, out-of-range angle/power and
  over-long or markup-laden names are all rejected or clamped server-side
  (`sanitizePlan`, `sanitizeName`, `GameRoom.onInput/onPlan`).
- Lifecycle: every phase is timer-driven on the server, so silence never
  stalls a match. Disconnects get a 30 s seat hold (their pot idles); after
  that, or on a deliberate leave, the pot is forfeited and cleared away. Mid-match joiners watch
  and get a pot next round at average HP. If no humans remain the match is abandoned (bots do not keep
  a room alive). Rooms are keyed by Discord `instanceId`.
- The server imports `@colyseus/core`, `@colyseus/ws-transport` and
  `@colyseus/schema` directly rather than the `colyseus` meta-package: same
  0.16 code, fewer transitive installs on a free-tier build. Schema classes
  use `defineTypes` instead of decorators to keep the TS config plain.

## Things I cut

- Pot-vs-pot collision and shoving (pots pass through each other).
- Wind. Simultaneous play already has plenty of uncertainty.
- Persistent scores across matches, cosmetics, map voting.
- Touch controls (the brief says mouse + keyboard).
- A kill-cam instant replay in Crumbs; the recap panel covers the "what
  happened" need at a fraction of the cost.

## Known limits

- Not launched inside a real Discord client by me: the embedded path
  (SDK handshake, `/.proxy` routing) is written to the documented contract
  but only the plain-browser path was executed.
- Phaser is ~1.5 MB minified (≈430 kB gzipped) in one chunk.
- Bots are simple: they wander, head for higher ground when the tea is
  coming, and aim by tracing candidate shots with some noise. Like a player
  reading the preview's warning, they re-draft (up to five times) any plan
  that the sim says would hurt themselves. Good for testing and filling a
  lobby, not for a challenge.
