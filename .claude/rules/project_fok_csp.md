# The game is CSP safe: nothing inline

index.html and every module stay clear of what a strict Content-Security-Policy
blocks:

- no inline `<script>`, only `<script src>`
- no inline event handlers (`onclick=` and friends)
- no `style=` attributes, no `<style>` blocks, no `setAttribute('style')`
- no `eval`, no `new Function`, no string handed to setTimeout
- no `javascript:` URLs, no `data:` URIs

Why: a policy must be addable at any time without auditing the app first. An
inline script a policy kills fails SILENTLY -- no error, the feature is just
gone.

How to apply: anything needing a runtime decision in the page shell cannot be an
inline script. Use static markup, or put the decision in a module under js/.
Concrete case: the API origin carries `rel="dns-prefetch"` and not a
`rel="preconnect"` gated on cfg.offline, because reading cfg in the shell would
take an inline script.

## The policy the code satisfies today

    default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self';
    font-src 'self'; worker-src 'self'; manifest-src 'self';
    connect-src 'self' https://fok-server.poggensee.it;
    base-uri 'none'; object-src 'none'; form-action 'none'

`blob:` needs no directive here: the two `createObjectURL` sites feed a download
and a share sheet, never a script or a worker.

## Two limits to know before shipping a policy

CSP does NOT cover WebRTC. `connect-src` never gated RTCPeerConnection, so STUN
and the DataChannel sit outside any policy. Chrome has an experimental `webrtc`
directive; do not set it, it would kill the duel.

GitHub Pages serves no CSP header and cannot be configured to, so a policy here
can only be a `<meta http-equiv>`. `frame-ancestors`, `sandbox` and `report-uri`
are ignored in meta form -- clickjacking cover needs a real header, i.e. a
different host.

Related: project_fok_pacing.md (the dns-prefetch and what it buys).
