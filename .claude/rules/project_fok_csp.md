# The game is CSP safe: nothing inline

index.html and every module stay clear of what a strict CSP blocks: no inline
`<script>`, no inline event handlers, no `style=` / `<style>` /
`setAttribute('style')`, no eval / new Function / string setTimeout, no
`javascript:` URLs, no `data:` URIs. An inline script a policy kills fails
SILENTLY. A runtime decision in the page shell goes into a module under js/
(the API origin gets `dns-prefetch`, not a cfg.offline-gated `preconnect`).

Policy the code satisfies:

    default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self';
    font-src 'self'; worker-src 'self'; manifest-src 'self';
    connect-src 'self' https://fok-server.poggensee.it;
    base-uri 'none'; object-src 'none'; form-action 'none'

`blob:` needs no directive (createObjectURL feeds a download and a share sheet
only). CSP does not cover WebRTC; never set Chrome's `webrtc` directive.
GitHub Pages serves no CSP header, so a policy here can only be a `<meta>`,
where frame-ancestors / sandbox / report-uri are ignored.
