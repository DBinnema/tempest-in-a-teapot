# Tempest in a Teapot

Simultaneous-turn teatime artillery for 2–8 players, built as a Discord
Activity. Porcelain teapots lob sweets at each other across a destructible
layer cake. Everyone moves at once, everyone plans in secret, and then
everything goes off together.

- **Scurry** (12 s) — everybody moves in real time: walk, hop, dig tunnels.
- **Steep** (26 s) — the world freezes. Privately queue up to two "lumps"
  (shots or tools) with live trajectory previews. Lump two fires 1.7 s after
  lump one, from wherever you have ended up.
- **Pour** — every plan is revealed and resolved at once on the server's
  deterministic simulation, replayed by each client with slow-motion,
  hit-stop and a camera that knows what is about to happen.
- **Crumbs** — who did what to whom, then the next round.

Last pot standing takes the cake. From round 3 the tea rises, a little
faster every round; after 12 rounds the pot with the most tea left wins.

## Run it locally

Requires Node 20 or newer.

```bash
npm install
npm run dev          # server on :2567, Vite client on http://localhost:5173
```

Open http://localhost:5173 in two tabs and press **I'm ready** in both. No
Discord is needed: outside Discord the SDK is never loaded and you play as a
guest. Useful URL parameters: `?name=Earl` picks a name, `?room=abc` picks a
room (tabs with the same room share a match). The first player in a room is
the host and can invite bots, so one tab plus a bot is enough to try it.

Production-style, one process serving everything on one origin:

```bash
npm install && npm run build && npm start     # http://localhost:2567
```

### Controls

| Phase  | Keys |
| ------ | ---- |
| Scurry | `A`/`D` walk · `W`/`Space` hop · hold `Shift` (or `F`) + a direction to dig |
| Steep  | mouse aims, click pins · `1`–`7` pick a sweet · `Tab` switch lump · arrows fine-tune (`Shift` = finer) · `R` clear · `Enter` lock in · wheel zooms, right-drag pans |
| Any    | `M` mute |

## Tests

```bash
npm test             # 24 headless tests (vitest)
npm run typecheck
npm run shots        # after a build: plays a match in Chrome/Edge, screenshots every phase into ./shots
npm run balance      # plays 60 headless 4-bot matches and prints pacing numbers
```

`tests/shared.test.ts` covers the PRNG, terrain determinism and variety,
cave/tunnel carving, collapse, movement rules, resolve determinism, the
tea schedule and the bots' refusal to shoot themselves.
`tests/e2e.test.ts` boots the real server and plays full matches with
several real Colyseus clients, checking that every client's replayed world
hash matches the server's after every round, plus late joins, leavers and
hostile input.

`npm run balance -- 40 8` runs 40 matches of 8 pots instead. It uses the
real terrain, physics, bot brains, sim and director without a network, so
it is the quickest way to see what a rule change does to match length.

`npm run shots` uses `playwright-core` with the Chrome or Edge already
installed on the machine; it downloads nothing.

## Deploy to Render (free tier)

1. Push this repository to GitHub.
2. In Render: **New → Blueprint**, pick the repository. `render.yaml`
   describes one free Node web service (build `npm install --include=dev &&
   npm run build`, start `npm start`, health check `/api/health`).
3. Set the three environment variables when asked (see below), deploy, and
   note the URL, e.g. `https://tempest-in-a-teapot.onrender.com`.

`VITE_DISCORD_CLIENT_ID` is baked into the client at build time, so after
changing it trigger a new deploy.

**Cold starts.** Free Render services sleep after about 15 minutes without
traffic and take up to a minute to wake. The first person to open the
Activity after a nap sees "Putting the kettle on…" while the client keeps
retrying; it connects by itself once the service is up. A sleeping service
also forgets any match in progress — rooms live in memory only.

## Wire it up to Discord

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
   and create a **New Application**.
2. **OAuth2** page: copy the **Client ID** and reset/copy the **Client
   Secret**. Add a redirect URI (any valid one, e.g. `https://127.0.0.1`;
   the Embedded App SDK requires one to exist but does not use it).
3. In Render, set
   - `DISCORD_CLIENT_ID` = the client ID
   - `VITE_DISCORD_CLIENT_ID` = the same client ID
   - `DISCORD_CLIENT_SECRET` = the client secret
4. **Activities → Settings**: enable Activities.
5. **Activities → URL Mappings**: map the root prefix `/` to your Render
   host **without** the scheme, e.g. `tempest-in-a-teapot.onrender.com`.
   That single mapping is all the game needs: the page, `/api/token` and the
   websocket all live on that one origin, reached through Discord's
   `/.proxy` path.
6. **Installation**: make sure the app can be installed to your server (or
   to your user), then install it.
7. Join a voice channel, open the Activity launcher (rocket icon) and start
   your app. While the app is unverified only members of the developer team
   and invited testers (**App Testers**) can launch it.

Inside Discord the client runs the SDK handshake (`ready` → `authorize`
with the `identify` scope → `POST /api/token` → `authenticate`) and uses
your Discord display name, sanitised by the server. Everyone in the same
voice-channel Activity instance lands in the same room. If the handshake
fails for any reason you still get in, as a guest.

For local testing inside Discord, run `npm run build && npm start`, expose
port 2567 with a tunnel such as `cloudflared tunnel --url
http://localhost:2567`, and point the URL mapping at the tunnel host. A
`.env` file (see `.env.example`) is read on start-up and at build time.

## Project layout

```
shared/   deterministic core: PRNG, fixed-point maths, terrain, pot physics,
          resolve sim, replay director, protocol, theme + content data
server/   Express + Colyseus room (authoritative phases, validation, bots)
client/   Phaser 4 + Vite; DOM HUD; everything drawn and synthesised in code
tests/    vitest: shared-core tests and multi-client end-to-end matches
tools/    screenshot driver, balance harness, ASCII terrain dumper
```

To reskin the game edit `shared/src/theme.ts` (names, words, colours, sound
patches). To rebalance or add weapons edit `shared/src/content/`. See
`DESIGN.md` for the decisions behind all of it.
