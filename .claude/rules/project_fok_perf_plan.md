# Perf sweep outcome (4.0.8) - the decision list

The sweep itself is spent; this file exists for the ranked decisions that must
not be silently reopened.

## Shipped in 4.0.8

- saveCfg batched through the idle writer as a thunk; the worker still gets its
  subset sync.
- drawGlass paints plain black under SIMPLE graphics instead of the
  full-canvas self-blur.
- The spectator fan-out serializes and size-checks an envelope ONCE and shares
  the string (_spEnv/_spSendJ/_spFan); nothing is serialized when no link is
  subscribed, so a leaf spectator pays nothing.
- _netHello skips netNetsRefresh() while netGameActive() - no throwaway ICE
  gather mid-match.
- CSS: #ring-egg long-hand instead of inset; :focus-visible split off the
  :focus list.

## Decided - do NOT reopen

The sweep ranked 11 findings; everything not shipped above was deliberately
left as is:

- One FIFO HTTP gate for all lanes: by design, protects the server. LEAVE.
- Full-canvas blur under dialogs: intentional; SIMPLE gfx blacks out instead.
- shadowBlur accessor / glow: LEAVE (do not tie SIMPLE to disableGlow).
- Tourney bracket/round anim every frame: LEAVE - they animate _ttDots + the
  host CONTINUE countdown.
- Rollback spike, iOS QR decode on main thread, seek interval, script tags /
  sw race, worker seam, touch listeners, getStats, sim allocs: LEAVE.
- The profiler's single `<< watch` line (qrDecodeImage 444px, ~4.8ms, ~29% of a
  frame) is expected and on the LEAVE list - do not re-raise it.

## Compat floor - decided, do not reopen

The floor is Chrome 55 / Safari 11 / Firefox 52, set by async/await with no
build step (dozens of async functions across most shipped modules). Moving it
means promise-chain rewrites or a build step; both considered and declined.
Also declined: grid fallbacks for Chromium 55/56 and Tizen keyCode 10009.
