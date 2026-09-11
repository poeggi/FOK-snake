# Audio changes need an explicit diff and approval

Never change `js/audio.js` or the audio call sites in `js/game.js` on your own
initiative, not even one-liners. Show the exact diff and what it changes;
implement only after explicit approval. Audio breaks in hard-to-debug ways
(iOS vs Firefox, Web Audio subtleties).
