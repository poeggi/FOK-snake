# MY ID QR share sheet - decided against, never built

Do NOT build or re-propose this unprompted. The research below is kept only so
an explicit future request does not start from zero.

## The idea

On the MY ID screen, tapping the friend QR opens the native share sheet so the
invite can go out via Messages/AirDrop/Copy instead of only being scanned.

## Why it is easy

- The QR encodes a URL, not an image: js/screens.js drawMyId() does
  qrMatrix(friendUrl()), and friendUrl() (js/storage.js) is
  GAME_URL + '#friend=' + getPlayerId().
- So the call is plain navigator.share({url: friendUrl(), ...}) - no
  canvas-to-blob, no canShare({files}) probe, no iOS-only gate, works on
  Android + desktop Safari too.
- The hard part is already device-verified in this repo by the ringtone egg
  (see project_fok_ringtone_egg.md): js/input.js _ringShareFile + the DOWNLOAD
  button handler bring up the real iOS sheet.

## The governing constraint (documented in js/input.js)

navigator.share() only runs inside the tap that called it - an await in
between spends the user gesture and iOS refuses the sheet. Sharing a URL has
nothing to await, so this costs nothing here - provided the call sits
synchronously in the tap handler.

## Edit surface (verified)

1. Hit-test the QR card, modelled on _scanTapAt / _scanInVF in js/input.js.
   Card rect from drawMyId(): card = (q.size + 8) * 8,
   qx = (CW - card) / 2, qy = 64.
2. Swallow the tap: today a tap anywhere on the MY ID screen falls through to
   handleKey('Enter') in the document touchend handler, which runs
   myId.confirm() and leaves the screen.
3. Keep the established convention: AbortError from navigator.share() means
   the sheet was dismissed - a decision, not a failure.

## The one real unknown

The verified ringtone share fires from a DOM click on a real button; that
works only because the document touchstart handler deliberately bails while
the panel is up. On the game canvas that bail does NOT apply - touchstart
calls preventDefault(), so there is no synthesized click and the tap arrives
as touchend. touchend IS an activation-triggering event per spec, so a
synchronous navigator.share() there should be honoured, but this repo has
never exercised that path on a device; Safari's gesture accounting after a
prevented touchstart needs a real iPhone to settle.

Fallback if it does not fire: on a QR tap open a small DOM overlay panel with
a real SHARE button, same shape as showRingOffer - one extra tap, but it
reuses code paths already proven on device.

## Also worth knowing before touching that screen

drawMyId() sets _netMyIdAt = Date.now() on every draw, so an incoming
friend request auto-accepts while the QR is showing (see net-session.js).
