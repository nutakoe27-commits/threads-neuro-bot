# War of Dots

A minimalist single-player real-time strategy game: gold and logistics instead of
resource gathering, morale, encirclement, and a front line that moves with your
army. No build step, no dependencies, no art assets — plain ES modules and a
`<canvas>`.

![Battle](screenshots/03-battle.png)

## Running it

The game uses ES modules, so the browser will refuse to load it from a `file://`
path — double-clicking `index.html` does not work. It has to be served over HTTP,
which is one command:

```bash
npm start          # serves ./game on http://localhost:8080
```

Any static server will do. On macOS, if you would rather not use Node:

```bash
python3 -m http.server 8080 --directory game
```

Then open <http://localhost:8080>. Stop the server with `Ctrl+C`.

> On a clean macOS install the first `python3` call opens a prompt to install the
> Xcode Command Line Tools. If you would rather skip that, use `npm start`, which
> only needs Node.

Nothing needs to be built or installed to play — the `npm install` step is only
required for the test and tuning scripts below.

## The rules, in full

* **You start with one base** (the big star) and a small purse of gold.
* **You win** by destroying every enemy base, or by holding **75% of the map**.
* **The black line is the front.** Territory belongs to whoever projects the most
  control over it — bases reach furthest, cities less, individual units least —
  so the line moves the moment an army moves.

### Economy: logistics, not mining

There are no workers and nothing to harvest.

| | |
|---|---|
| Base | **+4 gold/s** |
| Captured city | **+2 gold/s** |
| Every unit in the field | **−1 gold/s** |
| Unit garrisoned inside a city | **free** |

Gold buys units directly (light 30, heavy 85) and production only starts once the
unit is paid for. If upkeep outruns income the treasury goes negative and the
whole field army **starves**, losing health until you take more cities or lose
enough units. Cities pay twice over: income, plus free upkeep for whoever sits in
them.

### Morale

Troops under sustained fire lose morale. At zero they move at 55% speed and deal
45% damage — shaken before they are dead. Morale recovers out of contact, faster
next to a friendly base or city.

### Encirclement

A unit is supplied if it can trace a route home through ground the enemy does not
control. Cut that route and it is finished in about four seconds — surrounding an
army kills it far faster than shooting it does. This falls straight out of the
territory field, so it needs no separate bookkeeping.

### The two units

| | Light | Heavy |
|---|---|---|
| HP | 46 | 175 |
| Damage | 8/s | 28/s |
| Range | 32 | 42 |
| Speed | 70 | 44 |
| Cost | 30 | 85 |
| Build time | 3.5s | 9s |
| In rough ground | takes 20% less damage | deals 60% less, takes 30% more |
| On plains | — | **+25% speed** |

On screen: light is a plain dot, heavy wears a thick black ring.

### The ground

| | Passable | Notes |
|---|---|---|
| Plains (light green) | yes | Open ground. Heavy units move 25% faster here. |
| Forest (dark green) | yes | **Conceals**: units in forest are invisible until an enemy comes within 95 units. Heavies barely fight in it. |
| Hills (grey) | yes | Slow (0.7×), and heavies fight badly. |
| Mountain (dark grey) | yes | Very slow (0.45×). Passable, but a genuine barrier. |
| Water (blue) | **no** | Only crossable by bridge. |
| Road / bridge | yes | 1.35× / 1.25× marching speed. Pathing prefers them. |

Roads are generated per map as a minimum spanning tree over the map's points, and
turn into bridges wherever they cross water.

## Controls

| Input | Action |
|---|---|
| Left click / drag | Select · double-click selects all of that type on screen |
| Right click | Move, or attack the unit under the cursor |
| `A` | Attack-move · `S` stop · `H` hold · `Z` select whole army |
| `Q` / `W` | Build light / heavy at the selected base · `E` pauses its production |
| Right click with a base selected | Set its rally point |
| `Tab` | Cycle your bases · `F` centre on selection · `Ctrl`+`1..9` control groups |
| Arrows / screen edge / middle-drag | Pan · wheel to zoom · `Space` pause · `Esc` menu |

### On a phone

The whole game is playable with one thumb. Drag to pan, pinch to zoom, tap a unit
or city to select it, tap the ground to move there. Five large buttons sit along
the bottom:

* **Pan / Select** — flips dragging between moving the camera and drawing a
  selection box. A phone has no modifier keys, so this is an explicit mode.
* **Attack** — makes the next tap an attack-move. A long press does the same
  thing without the button.
* **All**, **Stop**, **Hold** — select the whole army, halt, or dig in.

The opening zoom is chosen from the viewport, so a phone starts with a usable
slice of map rather than the desktop framing. The HUD collapses to one row on
narrow screens, and the game pauses itself when the tab goes to the background.

## Modes

* **Skirmish** — 1v1, free-for-all, 2v2 with a bot ally, or 1-vs-everyone, on
  five hand-built maps.
* **Bot skill** — Recruit, Officer, Marshal. The tiers are verified to actually
  rank (see below), not just labelled differently.
* **Map editor** — paint plains, forest, hills, mountains and water, place player
  bases and neutral cities, save to local storage, play it.
* **Replays** — every finished match is recorded and can be replayed, scrubbed
  and re-watched. The simulation is deterministic, so a replay is just the seed
  plus the command log.

## Project layout

```
game/
  index.html          screens, HUD, overlays
  style.css
  src/
    config.js         all balance numbers and the terrain table live here
    game.js           the simulation: economy, combat, morale, supply, victory
    influence.js      territory, front lines and encirclement, from one field
    ai.js             bot controller — issues the same commands a human does
    pathfinder.js     A* over the terrain grid, with per-unit-type terrain costs
    terrain.js        terrain grid, blob generation, roads, run-length encoding
    contour.js        cell grid -> smooth outlines (terrain shapes, front lines)
    menu-demo.js      the live bot match behind the title screen
    maps.js           the built-in maps
    entities.js       Unit, Base and City
    session.js        one match: loop, camera, HUD, result
    input.js          mouse, keyboard and touch
    render.js         canvas drawing, baked terrain, minimap
    replay.js         record / play back / scrub
    editor.js         map editor
    storage.js        localStorage that tolerates sandboxed iframes
    platform.js       optional CrazyGames SDK, no-ops when absent
    main.js           screens and wiring
```

### Determinism

The simulation never calls `Math.random()`. It runs on a seeded PRNG at a fixed
60 Hz timestep, and cosmetic effects draw from a *separate* stream so that
turning them off can never change a match outcome. Bots have their own RNG for
the same reason: replays run with no AI at all, and any shared draw would desync
the whole match. `npm test` asserts a replayed match reproduces its original
byte-for-byte.

## Tools

These need Playwright, which is resolved from a local install or the global npm
root — no `NODE_PATH` juggling:

```bash
npm install -D playwright && npx playwright install chromium
```

```bash
npm test            # headless checks incl. replay determinism and every rule below
npm run shots       # the same run, writing screenshots/
npm run balance     # bot-vs-bot matches: match length + difficulty ordering
npm run diagnose    # one match, printed as a timeline: gold, army, land, base HP
npm run tune        # A/B one AI parameter at a time against a baseline
npm run tune:units  # heavy-leaning bot vs all-light bot, same tactics
npm run build       # dist/war-of-dots.zip, ready to upload
```

`diagnose.mjs` is the one to reach for when matches feel wrong rather than
merely unbalanced — it prints a 30-second-interval timeline of both economies,
army sizes, territory and base health, which makes a stalemate's cause obvious.
It has already paid for itself: the first build of these rules produced 60
timed-out matches out of 60, and the timeline showed why in one glance — base
health sat at a full 1600 for ten minutes straight, so nobody had ever attacked
one, and territory was frozen because unit influence could not shift it.

`tune.mjs` and `tune-units.mjs` are how the current numbers were arrived at, and
they have earned their keep twice:

* The first pass had the difficulty tiers *inverted* — "Marshal" lost to
  "Recruit" 7 times out of 9 — and heavies at a 19% win rate against an
  all-light bot with identical tactics.
* Adding roads and mountains silently changed which tactics win. Two levers
  flipped sign (steering around defended cities went from a liability to an
  advantage) and heavies fell back to 28%. The tiers had quietly collapsed to
  hard-beats-normal 60% before the sweep caught it.

A third came with the logistics rules: because a unit's influence did not stack,
ten soldiers claimed no more ground than one, so any army that stepped onto enemy
territory was instantly "encircled" and died in four seconds. Attacking was
literally impossible, and every match ran to the time limit. Units now accumulate
influence per cell, so a massed army out-projects a base and takes the ground it
stands on.

None of these were visible from reading the code. Re-run `npm run tune` and
`npm run tune:units` after any change to terrain, unit stats or maps, and
`npm run diagnose` whenever matches stop ending.

Current state: hard beats normal 22/30, hard beats easy 28/30, normal beats easy
27/30, and a heavy-leaning bot beats an all-light bot 56% of the time.

## Packaging for a portal

`npm run build` produces `dist/war-of-dots.zip` with `index.html` at the root,
which is what CrazyGames expects. Everything is relative-path and self-contained,
the canvas is responsive down to phone widths, touch controls are enabled
automatically, and the game auto-pauses when the tab is hidden.

`src/platform.js` will load the CrazyGames SDK and report gameplay start/stop and
loading events *if* the game is running inside an iframe and the SDK is
reachable. If it isn't, every call quietly does nothing and the game plays
exactly the same.

## Screenshots

The images in `screenshots/` are generated from this build by `npm run shots`.
