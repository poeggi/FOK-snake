# Audio changes require an explicit diff and approval

Never change `js/audio.js` or the audio call sites in `js/game.js` on your own initiative -- not even one-liners. Show the exact proposed diff, explain what it changes and why, and implement only after explicit approval.

Rationale: audio changes have repeatedly broken in ways that are hard to debug (iOS vs Firefox differences, Web Audio API subtleties).
