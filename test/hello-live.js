// What one hello.php round trip costs against the REAL server, in the shapes the client
// sends it, next to two static controls that separate the wire from what hello costs on it:
//
//   t.txt            a static file, the clock source: connection + HTTP cost only
//   version.txt      the other static file: the same wire cost, no work behind it
//   hello            the heartbeat ({id, name}): worker start-up plus hello's own work
//   hello +tourneys  the tournament lobby's 5 s shape (asks for the announce list)
//   hello +held poll the same, while this id's own 5 s poll is parked server-side
//
// Everything rides ONE HTTP/2 session, the way a browser talks to this host: the parked
// poll is a stream on it, not a connection of its own, so a hello beside it shares the wire
// and pays nothing for the company. Only the first request of the run opens the connection
// (marked *). A host that does not offer h2 fails the run: that is a finding, not a case to
// fall back from -- the browsers would be on HTTP/1.1 there and every request beside a
// parked poll would need a second connection.
//
// Every lane sends its samples one at a time, past the contract's 100 ms gap, so nothing of
// ours stacks except the parked poll in the last lane. Per lane: min / median / max of the
// client-measured round trip, the largest q_ms the server reports (what a request waited for
// a worker before any of its work ran), and the raw samples in order.
//
// Then the rounds: hello alone, then a poll parked and a hello 200 ms into it, the poll
// waited out. A q_ms that shows up only beside the poll is the pool finding a second worker.
//
//   node test/hello-live.js [base-url] [samples-per-lane] [rounds]
//
// A measurement, not a contract: it fails only when a request fails. On demand only -- it
// needs the network and a deployment, and takes about a minute. The fixed live-test id keeps
// the residue to one row.

const http2 = require('http2');

const BASE = process.argv[2] || 'https://fok-server.poggensee.it';
const N = Math.max(3, Math.min(30, parseInt(process.argv[3] || '8', 10) || 8));
const ROUNDS = Math.max(1, Math.min(20, parseInt(process.argv[4] || '4', 10) || 4));
const GAP_MS = 300;                   // between samples: past the client's own 100 ms gap
const POLL_S = 5;                     // the contract's longest hold
const ID = '1111c1e7';
const NAME = 'clnt-CI-' + ID.slice(0, 4);   // the same name items-live.js records for this id

const sleep = ms => new Promise(res => setTimeout(res, ms));
let failed = 0;
let session = null, used = false;

function connect() {
    return new Promise(res => {
        session = http2.connect(BASE);
        session.on('error', () => {});
        session.once('connect', () => res(session.socket.alpnProtocol || 'h2'));
        session.once('close', () => { if (!session.__ok) res(null); });
    });
}

// One request, timed from send to the last body byte; q_ms read off a JSON body when there
// is one; fresh = this request opened the connection.
function timed(method, path, body) {
    return new Promise(res => {
        const t0 = performance.now();
        const data = body === undefined ? null : JSON.stringify(body);
        const fresh = !used; used = true;
        const hdrs = { ':method': method, ':path': path };
        if (data) { hdrs['content-type'] = 'application/json'; hdrs['content-length'] = Buffer.byteLength(data); }
        const req = session.request(hdrs);
        let status = 0, txt = '';
        req.setEncoding('utf8');
        req.on('response', h => { status = h[':status'] | 0; });
        req.on('data', d => { txt += d; });
        req.on('end', () => {
            let q = null;
            try { const j = JSON.parse(txt); if (j && typeof j.q_ms === 'number') q = j.q_ms; } catch (e) { /* not JSON */ }
            res({ ms: performance.now() - t0, status, q, fresh });
        });
        req.setTimeout(20000, () => req.close(http2.constants.NGHTTP2_CANCEL));
        req.on('error', () => res({ ms: performance.now() - t0, status: 0, q: null, fresh }));
        if (data) req.write(data);
        req.end();
    });
}

const hello = (extra) => timed('POST', '/api/hello.php', Object.assign({ id: ID, name: NAME }, extra || {}));
const poll = () => timed('GET', '/api/poll.php?id=' + ID + '&wait=' + POLL_S);
const fmt = x => Math.round(x.ms) + (x.fresh ? '*' : '');

function check(label, s, okStatus) {
    const bad = s.filter(x => !okStatus.includes(x.status));
    if (bad.length) { failed++; console.log('  FAIL ' + label + ': ' + bad.length + ' of ' + s.length + ' answered ' + bad.map(x => x.status).join(',')); }
}

async function lane(label, req) {
    const s = [];
    for (let i = 0; i < N; i++) {
        if (i) await sleep(GAP_MS);
        s.push(await req());
    }
    check(label, s, [200]);
    const ms = s.map(x => x.ms).sort((a, b) => a - b);
    const med = ms[Math.floor(ms.length / 2)];
    const qMax = Math.max(0, ...s.map(x => x.q === null ? 0 : x.q));
    const hasQ = s.some(x => x.q !== null);
    console.log('  ' + label.padEnd(17)
        + 'min ' + String(Math.round(ms[0])).padStart(4) + '  med ' + String(Math.round(med)).padStart(4)
        + '  max ' + String(Math.round(ms[ms.length - 1])).padStart(4)
        + (hasQ ? '  q_ms max ' + String(qMax).padStart(3) : '           ')
        + '   [' + s.map(fmt).join(' ') + ']');
    return med;
}

async function main() {
    const t0 = performance.now();
    const proto = await connect();
    if (proto !== 'h2') { console.log('[hello-live] ' + BASE + ' did not give us HTTP/2 (' + (proto || 'no session') + ') -- FAILED'); process.exit(1); }
    session.__ok = true;
    console.log('[hello-live] ' + BASE + '   ' + proto + ' in ' + Math.round(performance.now() - t0) + ' ms   as ' + NAME
        + ', ' + N + ' samples per lane, ' + GAP_MS + ' ms apart   (* = first request on the connection)');
    const tTxt = await lane('t.txt', () => timed('GET', '/api/t.txt'));
    const ver = await lane('version.txt', () => timed('GET', '/api/version.txt'));
    const plain = await lane('hello', () => hello());
    await lane('hello +tourneys', () => hello({ tourneys: true }));

    // The poll parks for POLL_S seconds; the hellos go out beside it, then it is waited out.
    let p = poll();
    await sleep(200);
    await lane('hello +held poll', () => hello({ tourneys: true }));
    p = await p;
    check('held poll', [p], [200, 204]);
    console.log('  held poll        came back after ' + Math.round(p.ms) + ' ms (' + p.status + ')');

    console.log('  medians: wire ' + Math.round(tTxt) + '  wire noise ' + Math.round(ver - tTxt)
        + '  +server work ' + Math.round(plain - tTxt) + '  (ms)');

    console.log('[hello-live] rounds: hello alone, then one hello 200 ms into a parked poll');
    for (let i = 0; i < ROUNDS; i++) {
        const alone = await hello({ tourneys: true });
        p = poll();
        await sleep(200);
        const beside = await hello({ tourneys: true });
        p = await p;
        check('round ' + i, [alone, beside], [200]);
        check('round ' + i + ' poll', [p], [200, 204]);
        console.log('  round ' + i + ':  alone ' + String(fmt(alone)).padStart(5) + ' ms q_ms ' + String(alone.q === null ? '-' : alone.q).padStart(3)
            + '   beside ' + String(fmt(beside)).padStart(5) + ' ms q_ms ' + String(beside.q === null ? '-' : beside.q).padStart(3)
            + '   poll ' + p.status + ' after ' + Math.round(p.ms) + ' ms');
    }
    session.close();
    if (failed) { console.log('[hello-live] ' + failed + ' request(s) FAILED'); process.exit(1); }
    console.log('[hello-live] done');
}

main().catch(e => { console.log('[hello-live] ' + (e && e.stack || e)); process.exit(1); });
