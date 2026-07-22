# Snake - FOK Edition

Snake FOK Edition uses classic Snake as its starting point, but it is as much a love letter to retro arcade gaming as it is a Snake clone. Power pellets, bonus multiplier chains, border barricades that crumble on impact, extra lives hidden across levels -- it all adds up to something that feels like flipping through an arcade cabinet catalogue from the 1980s.

**Play online:** https://poeggi.github.io/FOK-snake/

## Items

| | Item | Description |
|:-:|------|-------------|
| ![Gem](docs/gem.svg) | **Gem** | The main collectible. 10 per level. Grab in the fewest steps for a x2 score bonus. |
| ![Lucky Gem](docs/gem-lucky.svg) | **Lucky Gem** | Rare gold gem. Worth 10x or 20x the normal score bonus. |
| ![Epic Gem](docs/gem-epic.svg) | **Epic Gem** | Extremely rare rainbow gem. Worth 80x or 160x the normal score bonus. |
| ![Gouranga Gem](docs/gem-gouranga.svg) | **Gouranga Bonus** | Seven orange gems appear in a line -- horizontal, vertical, or diagonal. Collect all seven in sequence for escalating x2, x4, x6 ... score multipliers. Hare Krishna. |
| ![Power Pellet](docs/power-pellet.svg) | **Power Pellet** | A Pac-Man nod, from level 2 onward: a two-tone capsule that turns your head into a chomping Pac-Man while it lasts. For 6 seconds all barricades turn fragile AND flee across the board like frightened ghosts -- crash through everything. They blink as the effect fades and freeze wherever they are when it ends. |
| ![Time Crystal](docs/time-crystal.svg) | **Time Crystal** | Rare icy pickup from level 6 onward (chance rises with the level). Collect it to slow the whole board to level-3 speed for 30 seconds; a field-wide shimmer marks the warp and blinks as it runs out. |
| ![1UP Heart](docs/heart.svg) | **1UP Heart** | Extra life. Appears once during levels 4-6 and occasionally on respawn in later levels. Blinks before disappearing. Can push you above the starting three lives. |
| ![Barricade](docs/barricade.svg) | **Barricade** | Solid orange brick. Colliding costs a life. Grows in number each level. |
| ![Fragile Barricade](docs/barricade-fragile.svg) | **Fragile Barricade** | Crumbling border block. The snake can smash straight through it for +1000 FOKoins and a debris effect. Activated by the Power Pellet. |

## Controls

| Input | Action |
|-------|--------|
| Arrow keys | Move snake / navigate menus |
| Space | Pause / unpause |
| Escape | Quit to menu (in-game) |
| Enter / OK | Select / confirm |
| Backspace | Delete (name entry) |
| M | Toggle music |

Mobile: X-shaped d-pad + OK/pause/ESC side buttons. Swipe the canvas to steer. Tap the canvas during name entry to open the keyboard.

## Difficulty modes

| | Easy | Normal | Hard |
|-|------|--------|------|
| Speed | Slow | Standard | Fast |
| Barricades | Few | Standard | Many |
| Growth per gem | +1 | +2 | +2 |
| Snake length at level start | Resets | Resets | Carries over from previous level |
| Achievements | Basic only | Full | Full + Iron Snake |

**Easy** awards only: first gem, level 1, level 5, and FOKoin milestones. Completing all 10 levels requires Normal or higher.

**Hard** carries your snake's full length into each new level, so the board fills up over time just like the original Nokia Snake.

## Features

- 10 levels - speed and barricades increase each level
- Snake grows by 1 segment per gem on Easy, 2 on Normal and Hard
- Screen wraps on all edges
- 3 lives - barricades and self-collision cost one life each
- 10 gems per level; collect in fewest steps for a x2 score bonus
- Lucky gems (x10/x20) and Epic gems (x80/x160) spawn randomly
- Time Crystal (level 6+): slows the board to level-3 speed for 30 seconds
- Pause with Space; quit-to-menu confirm on Escape
- Two music styles: NEW (3-channel chiptune) and CLASSIC (2-channel retro) - switchable in Settings
- Music pauses on death, resumes on restart
- Arcade SFX for eating, dying, level up
- High score table (saved locally, top 10)
- FOKoins: lifetime score accumulator across all sessions, spent in the shop
- Shop with two pages of cosmetics: necktie, sunglasses, cylinder hat, monocle, bow tie (page 1); shoes, moustache, halo, wizard hat, royal crown, and the invisible gown that shimmers only while you outscore the record (page 2); plus a repeatable DONATE
- NEW SNAKE TIMES: in-game news page for release announcements (newspaper icon on the main menu)
- Smileys allowed in high-score names (characters like : - ( ) [ ] ')
- Achievements and expert achievements
- FPS counter
- Scrolling credits screen
- Mobile-friendly responsive layout with portrait and landscape support
- REDUCE MOTION setting (seeded from the OS accessibility preference) that
  suppresses decorative motion such as the duel near-miss shake
- Installable PWA (works offline)
- 1:1 duels, local (one keyboard) and ONLINE: classic level progression for two,
  power pellets that turn the opponent's snake into food, PLAY AGAIN rematches,
  and a camera shake when the two heads brush past -- heavier, with a sonic
  boom, when both snakes are boosting through the pass
- Friend system: 32-bit player ID, friend-link QR code (SHOW MY ID) and an
  in-app camera QR scanner with a dependency-free decoder (ADD FRIEND)
- Online matchmaking via FOK-server (invite friends with live online status and
  latency, quick match) -- game traffic runs peer-to-peer over a WebRTC
  DataChannel, with an HTTP relay fallback when P2P cannot connect. The netcode is
  deterministic lockstep with rollback: both clients run the same inputs-only sim
  off a shared PTS clock, so there is no host and controls feel local on both ends;
  a periodic authoritative-state exchange heals any divergence. A RELAY ONLY (NO
  P2P) setting forces the HTTP relay path for networks where WebRTC never connects
- Global online top-100 high scores, submitted with the deterministic replay
  material (seed + tick-stamped inputs) for server-side validation
- Config backup / restore -- to a JSON file or to the cloud (kept by id + a secret
  token, with an optional once-a-day auto-backup); the player id also lives in a
  cookie, so identity survives a browser "clear site data"
- STRICTLY OFFLINE setting: with it ON (or no network at all) the game never
  sends a single request -- every online feature is strictly additive
- Debug tools: on-screen network / timing / sim overlays (PTS clock, latency,
  rollback + divergence counters), a JSON debug export, a worst-frame FPS recorder,
  and a one-click cloud debug snapshot (state + screenshot -> a short support PIN)

## Server

Online features speak to FOK-server (https://fok-server.poggensee.it, repo
`poeggi/FOK-server`); the client-facing contract is that repo's docs/API.md --
matchmaking, signaling, PTS time sync, latency reporting and global scores.
This client requires an **API v3** server (PTS time sync + epoch-keyed starts);
an older server will not matchmake or start duels. Single-player is unaffected.
The engine runs on a deterministic fixed-timestep 60 Hz tick clock, which is
what makes prediction netcode and replay-validated scores possible.
(docs/multiplayer-server-prompt.md is the historical design brief.)

## Setup (GitHub Pages)

In repo Settings -> Pages -> Source: Deploy from branch -> main -> / (root)

## Development

`sw.js` (service-worker cache version + asset list) is auto-managed by a
pre-commit hook. Enable it once after cloning:

    git config core.hooksPath .githooks

The hook derives MAJOR.MINOR from the latest git tag and bumps the PATCH on every
commit, so installed PWA clients always pick up fresh assets. Do not edit the
version/CACHE/ASSETS lines in sw.js by hand.
