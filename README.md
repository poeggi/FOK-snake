# Snake - FOK Edition

Classic Snake in the browser. 10 levels, arcade music, high scores, FOKoins.

**Play online:** https://poeggi.github.io/FOK/

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
| Snake length at level start | Resets | Resets | Carries over from previous level |
| Achievements | Basic only | Full | Full + Iron Snake |

**Easy** awards only: first gem, level 1, level 5, and FOKoin milestones. Completing all 10 levels requires Normal or higher.

**Hard** carries your snake's full length into each new level, so the board fills up over time just like the original Nokia Snake.

## Features

- 10 levels - speed and barricades increase each level
- Snake grows by 2 segments per gem collected
- Screen wraps on all edges
- 3 lives - barricades and self-collision cost one life each
- 10 gems per level; collect in fewest steps for a x2 score bonus
- Lucky gems (x10/x20) and Epic gems (x100/x200) spawn randomly
- Pause with Space; quit-to-menu confirm on Escape
- Two music styles: NEW (3-channel chiptune) and CLASSIC (2-channel retro) - switchable in Settings
- Music pauses on death, resumes on restart
- Arcade SFX for eating, dying, level up
- High score table (saved locally, top 10)
- FOKoins: lifetime score accumulator across all sessions, spent in the shop
- Achievements and expert achievements
- FPS counter
- Scrolling credits screen
- Mobile-friendly responsive layout with portrait and landscape support
- Installable PWA (works offline)

## Setup (GitHub Pages)

In repo Settings -> Pages -> Source: Deploy from branch -> main -> / (root)
