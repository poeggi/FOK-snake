# PWA install / manifest facts

- apple-touch-icon points at icon.svg and this WORKS on real iOS (device
  verified home-screen icon). Do NOT "fix" it to PNG - that swap was made once
  and reverted.
- manifest.json has NO orientation key on purpose: the game supports landscape
  (dedicated HUD layout). Do not add a lock.
- Android link capture into the installed app is automatic via WebAPK scope
  (https://poeggi.github.io/FOK-snake/); no config needed, #friend= URLs reach
  the app. A custom fok:// scheme was rejected (dead link without the app,
  web+ prefix required, iOS ignores it).
- iOS has no link capture and home-screen storage is ISOLATED from Safari;
  the fallback is manual friend-code entry (see
  project_fok_multiplayer_netcode.md).
