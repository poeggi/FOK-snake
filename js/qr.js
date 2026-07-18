// ============================================================================
// qr.js -- minimal QR encoder for the friend-link (SETTINGS > USER). Fixed shape:
// Version 3 (29x29 modules), byte mode, ECC level L (55 data + 15 ECC codewords,
// max 53 text bytes -- the friend URL is ~51), mask pattern 0. No dependencies;
// algorithms follow ISO/IEC 18004 (GF(256) poly 0x11D, format BCH 0x537^0x5412).
// The Reed-Solomon math is verified by test/smoke-save.js (all syndromes zero).
// ============================================================================
const QR_SIZE = 29, QR_DATA_CW = 55, QR_ECC_CW = 15;

// GF(256) multiply, reducer polynomial 0x11D (Russian-peasant, no tables).
function _gfMul(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
        z = (z << 1) ^ ((z >>> 7) * 0x11D);
        z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xFF;
}
// Reed-Solomon generator polynomial of the given degree: product of (x - a^i).
function _rsDivisor(degree) {
    const result = new Array(degree).fill(0);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
        for (let j = 0; j < degree; j++) {
            result[j] = _gfMul(result[j], root) ^ (j + 1 < degree ? result[j + 1] : 0);
        }
        root = _gfMul(root, 2);
    }
    return result;
}
// Remainder of data / divisor = the ECC codewords.
function _rsRemainder(data, divisor) {
    const result = new Array(divisor.length).fill(0);
    for (const b of data) {
        const factor = b ^ result.shift();
        result.push(0);
        for (let j = 0; j < divisor.length; j++) result[j] ^= _gfMul(divisor[j], factor);
    }
    return result;
}
// Full codeword sequence (data + ECC) for a byte-mode payload.
function _qrCodewords(text) {
    if (text.length > QR_DATA_CW - 2) throw new Error('qr: payload too long: ' + text.length);
    const bits = [];
    const push = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    push(4, 4);                 // byte mode
    push(text.length, 8);       // char count (8 bits for versions 1-9)
    for (let i = 0; i < text.length; i++) push(text.charCodeAt(i) & 0xFF, 8);
    push(0, Math.min(4, QR_DATA_CW * 8 - bits.length));   // terminator
    while (bits.length % 8 !== 0) bits.push(0);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) {
        let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
        data.push(b);
    }
    for (let pad = 0xEC; data.length < QR_DATA_CW; pad ^= 0xEC ^ 0x11) data.push(pad);
    return data.concat(_rsRemainder(data, _rsDivisor(QR_ECC_CW)));
}
// Build the 29x29 module matrix. Returns {size, m} with m[row][col] = true for dark.
let _qrCache = null;
function qrMatrix(text) {
    if (_qrCache && _qrCache.text === text) return _qrCache.q;
    const S = QR_SIZE;
    const m = Array.from({length: S}, () => new Array(S).fill(false));
    const fn = Array.from({length: S}, () => new Array(S).fill(false));
    const set = (col, row, dark) => { m[row][col] = dark; fn[row][col] = true; };
    // Timing patterns (finders overwrite their ends below).
    for (let i = 0; i < S; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    // Finder patterns + separators (distance 2 and 4 are light).
    const finder = (cx, cy) => {
        for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
            const x = cx + dx, y = cy + dy;
            if (x < 0 || x >= S || y < 0 || y >= S) continue;
            const dist = Math.max(Math.abs(dx), Math.abs(dy));
            set(x, y, dist !== 2 && dist !== 4);
        }
    };
    finder(3, 3); finder(S - 4, 3); finder(3, S - 4);
    // Alignment pattern (version 3: single one at (22,22)); light ring at distance 1.
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        set(22 + dx, 22 + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    // Format info: ECC L (formatBits 1) + mask 0, BCH-protected, both copies + dark module.
    const fdata = (1 << 3) | 0;
    let rem = fdata;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const fbits = ((fdata << 10) | rem) ^ 0x5412;
    const fbit = i => ((fbits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, fbit(i));
    set(8, 7, fbit(6)); set(8, 8, fbit(7)); set(7, 8, fbit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, fbit(i));
    for (let i = 0; i < 8; i++) set(S - 1 - i, 8, fbit(i));
    for (let i = 8; i < 15; i++) set(8, S - 15 + i, fbit(i));
    set(8, S - 8, true);   // the always-dark module
    // Data placement: zigzag from the bottom-right, skipping column 6, then mask 0.
    const cw = _qrCodewords(text);
    let bi = 0;
    for (const [x, y] of _qrDataOrder()) {
        if (fn[y][x]) throw new Error('qr: placement order out of sync');   // must never fire (see _qrIsFn)
        let dark = false;
        if (bi < cw.length * 8) { dark = ((cw[bi >>> 3] >>> (7 - (bi & 7))) & 1) === 1; bi++; }
        if ((x + y) % 2 === 0) dark = !dark;   // mask pattern 0
        m[y][x] = dark;
    }
    const q = { size: S, m };
    _qrCache = { text, q };
    return q;
}

// ============================================================================
// DECODER -- camera scan of OUR OWN code only (fixed V3-L mask 0, see above).
// Binarize, locate the three finder patterns (1:1:3:1:1 run ratios), affine-map
// the 29x29 grid (phone screens are flat: no perspective needed), unmask and
// extract the codewords. A frame is accepted ONLY if all 15 Reed-Solomon
// syndromes are zero -- a misread frame is dropped, never a wrong result.
// ============================================================================
// Function-module predicate: the static V3 geometry (finders + separators +
// format, timing row/col, alignment ring, dark module). Everything else is data.
function _qrIsFn(x, y) {
    const S = QR_SIZE;
    return (x < 9 && y < 9) || (x >= S - 8 && y < 9) || (x < 9 && y >= S - 8)
        || x === 6 || y === 6 || (x >= 20 && x <= 24 && y >= 20 && y <= 24);
}
// Data-module coordinates in placement order (encoder writes, decoder reads).
let _qrOrderMemo = null;
function _qrDataOrder() {
    if (_qrOrderMemo) return _qrOrderMemo;
    const S = QR_SIZE, ord = [];
    for (let right = S - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (let vert = 0; vert < S; vert++) {
            for (let j = 0; j < 2; j++) {
                const x = right - j;
                const upward = ((right + 1) & 2) === 0;
                const y = upward ? S - 1 - vert : vert;
                if (!_qrIsFn(x, y)) ord.push([x, y]);
            }
        }
    }
    return (_qrOrderMemo = ord);
}
// Finder-pattern centers: rows are run-length scanned for the 1:1:3:1:1 signature,
// each hit is cross-checked vertically, and nearby hits are clustered.
function _qrFinderCenters(g, W, H) {
    const raw = [];
    const ratioOk = (a, b, c, d, e) => {
        const u = (a + b + c + d + e) / 7;
        return u >= 1 &&
            Math.abs(a - u) <= u * 0.75 && Math.abs(b - u) <= u * 0.75 &&
            Math.abs(c - 3 * u) <= u * 1.5 &&
            Math.abs(d - u) <= u * 0.75 && Math.abs(e - u) <= u * 0.75;
    };
    for (let y = 0; y < H; y++) {
        const runs = [];
        let x0 = 0;
        for (let x = 1; x <= W; x++) {
            if (x === W || g[y * W + x] !== g[y * W + x0]) { runs.push([g[y * W + x0], x0, x - x0]); x0 = x; }
        }
        for (let i = 0; i + 4 < runs.length; i++) {
            if (runs[i][0] !== 1) continue;
            const [a, b, c, d, e] = [runs[i][2], runs[i+1][2], runs[i+2][2], runs[i+3][2], runs[i+4][2]];
            if (!ratioOk(a, b, c, d, e)) continue;
            const cx = runs[i + 2][1] + c / 2;
            // Vertical cross-check at cx: the same 5-run signature must appear.
            const col = xx => g[xx];
            let yu = y; while (yu > 0        && col((yu - 1) * W + (cx | 0)) === 1) yu--;
            let yd = y; while (yd < H - 1    && col((yd + 1) * W + (cx | 0)) === 1) yd++;
            const vc = yd - yu + 1;
            let y1 = yu; while (y1 > 0       && col((y1 - 1) * W + (cx | 0)) === 0) y1--;
            let y4 = yd; while (y4 < H - 1   && col((y4 + 1) * W + (cx | 0)) === 0) y4++;
            let y0 = y1; while (y0 > 0       && col((y0 - 1) * W + (cx | 0)) === 1) y0--;
            let y5 = y4; while (y5 < H - 1   && col((y5 + 1) * W + (cx | 0)) === 1) y5++;
            if (!ratioOk(y1 - y0, yu - y1, vc, y4 - yd, y5 - y4)) continue;
            raw.push({ x: cx, y: (yu + yd) / 2, u: (a + b + c + d + e) / 7, n: 1 });
        }
    }
    const out = [];
    for (const r of raw) {
        const hit = out.find(o => Math.abs(o.x - r.x) < 4 * o.u && Math.abs(o.y - r.y) < 4 * o.u);
        if (hit) { hit.x = (hit.x * hit.n + r.x) / (hit.n + 1); hit.y = (hit.y * hit.n + r.y) / (hit.n + 1); hit.n++; }
        else out.push({ ...r });
    }
    return out.filter(o => o.n >= 2).sort((p, q) => q.n - p.n);
}
// GF(256) exp/log tables (built from _gfMul) + inverse, for the RS decoder.
const _GF_EXP = new Uint8Array(512), _GF_LOG = new Uint8Array(256);
(function () {
    let x = 1;
    for (let i = 0; i < 255; i++) { _GF_EXP[i] = x; _GF_LOG[x] = i; x = _gfMul(x, 2); }
    for (let i = 255; i < 512; i++) _GF_EXP[i] = _GF_EXP[i - 255];
})();
function _gfInv(a) { return _GF_EXP[255 - _GF_LOG[a]]; }
// Reed-Solomon error correction (Berlekamp-Massey + Chien + Forney, fcr=0):
// repairs up to 7 wrong codewords, then re-verifies EVERY syndrome -- so a
// frame is either corrected to the true codeword or rejected, never wrong.
function _rsCorrect(cw) {
    const N = cw.length, T = QR_ECC_CW;
    const S = new Array(T);
    let bad = false, alpha = 1;
    for (let i = 0; i < T; i++) {
        let v = 0;
        for (const c of cw) v = _gfMul(v, alpha) ^ c;
        S[i] = v; if (v) bad = true;
        alpha = _gfMul(alpha, 2);
    }
    if (!bad) return cw;
    let sigma = [1], B = [1], L = 0, m = 1, b = 1;   // Berlekamp-Massey
    for (let i = 0; i < T; i++) {
        let delta = S[i];
        for (let j = 1; j <= L; j++) delta ^= _gfMul(sigma[j] || 0, S[i - j]);
        if (delta === 0) { m++; continue; }
        const prev = sigma.slice();
        const coef = _gfMul(delta, _gfInv(b));
        for (let j = 0; j < B.length; j++) sigma[j + m] = (sigma[j + m] || 0) ^ _gfMul(coef, B[j]);
        if (2 * L <= i) { L = i + 1 - L; B = prev; b = delta; m = 1; } else m++;
    }
    if (L > (T >> 1)) return null;                    // beyond correction capacity
    const errPos = [];                                // Chien search
    for (let l = 0; l < N; l++) {
        const xinv = _GF_EXP[(255 - l) % 255];
        let v = 0;
        for (let j = sigma.length - 1; j >= 0; j--) v = _gfMul(v, xinv) ^ (sigma[j] || 0);
        if (v === 0) errPos.push(l);
    }
    if (errPos.length !== L) return null;
    const omega = new Array(T).fill(0);               // omega = S*sigma mod x^T
    for (let i = 0; i < T; i++) for (let j = 0; j < sigma.length && i + j < T; j++)
        omega[i + j] ^= _gfMul(S[i], sigma[j] || 0);
    const out = cw.slice();
    for (const l of errPos) {                         // Forney magnitudes
        const xinv = _GF_EXP[(255 - l) % 255];
        let num = 0;
        for (let j = omega.length - 1; j >= 0; j--) num = _gfMul(num, xinv) ^ omega[j];
        let den = 0;
        for (let j = 1; j < sigma.length; j += 2) den ^= _gfMul(sigma[j] || 0, _GF_EXP[((255 - l) * (j - 1)) % 255]);
        if (den === 0) return null;
        out[N - 1 - l] ^= _gfMul(_GF_EXP[l % 255], _gfMul(num, _gfInv(den)));
    }
    alpha = 1;                                        // re-verify: no wrong fixes, ever
    for (let i = 0; i < T; i++) {
        let v = 0;
        for (const c of out) v = _gfMul(v, alpha) ^ c;
        if (v !== 0) return null;
        alpha = _gfMul(alpha, 2);
    }
    return out;
}
// Projective map from four point pairs (Gauss-Jordan on the 8x8 DLT system).
function _homography(src, dst) {
    const A = [];
    for (let i = 0; i < 4; i++) {
        const x = src[i][0], y = src[i][1], X = dst[i][0], Y = dst[i][1];
        A.push([x, y, 1, 0, 0, 0, -x * X, -y * X, X]);
        A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y, Y]);
    }
    for (let col = 0; col < 8; col++) {
        let piv = col;
        for (let r = col + 1; r < 8; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
        if (Math.abs(A[piv][col]) < 1e-9) return null;
        const t = A[col]; A[col] = A[piv]; A[piv] = t;
        for (let r = 0; r < 8; r++) {
            if (r === col) continue;
            const f = A[r][col] / A[col][col];
            for (let c = col; c < 9; c++) A[r][c] -= f * A[col][c];
        }
    }
    const h = A.map((row, i) => row[8] / row[i]);
    return (x, y) => {
        const w = h[6] * x + h[7] * y + 1;
        return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
    };
}
// Decode an RGBA image ({data,width,height}); returns the payload string or null.
function qrDecodeImage(img) {
    const W = img.width, H = img.height, d = img.data;
    // Adaptive threshold: 8x8 tile means, each pixel compared against the average
    // of its 3x3 tile neighborhood -- robust against uneven camera lighting.
    const lum = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) lum[i] = (d[i * 4] * 3 + d[i * 4 + 1] * 6 + d[i * 4 + 2]) / 10;
    const tw = W / 8, th = H / 8, tm = [];
    for (let ty = 0; ty < 8; ty++) {
        tm.push([]);
        for (let tx = 0; tx < 8; tx++) {
            let s = 0, n = 0;
            for (let y = (ty * th) | 0; y < (((ty + 1) * th) | 0); y++)
                for (let x = (tx * tw) | 0; x < (((tx + 1) * tw) | 0); x++) { s += lum[y * W + x]; n++; }
            tm[ty].push(s / n);
        }
    }
    const thr = [];
    for (let ty = 0; ty < 8; ty++) {
        thr.push([]);
        for (let tx = 0; tx < 8; tx++) {
            let s = 0, n = 0;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                const yy = ty + dy, xx = tx + dx;
                if (yy >= 0 && yy < 8 && xx >= 0 && xx < 8) { s += tm[yy][xx]; n++; }
            }
            thr[ty].push(s / n);
        }
    }
    const g = new Uint8Array(W * H);
    const txOf = new Uint8Array(W), thrFlat = new Float64Array(64);
    for (let x = 0; x < W; x++) txOf[x] = Math.min(7, (x / tw) | 0);
    for (let ty = 0; ty < 8; ty++) for (let tx = 0; tx < 8; tx++) thrFlat[ty * 8 + tx] = thr[ty][tx];
    for (let y = 0; y < H; y++) {
        const base = Math.min(7, (y / th) | 0) * 8, row = y * W;
        for (let x = 0; x < W; x++) g[row + x] = lum[row + x] < thrFlat[base + txOf[x]] ? 1 : 0;
    }
    // Junk clusters (a handful of confirmations vs dozens for a real finder) can
    // form geometrically perfect triples that beat the true, warped one -- filter
    // by relative strength, rank the surviving triples by strength, and let the
    // RS gate reject a wrong pick: try the best three through the full pipeline.
    let cs = _qrFinderCenters(g, W, H).slice(0, 6);
    if (cs.length >= 1) cs = cs.filter(c => c.n >= cs[0].n / 8);
    if (cs.length < 3) return null;
    const triples = [];
    for (let i = 0; i < cs.length; i++) for (let j = 0; j < cs.length; j++) for (let k = j + 1; k < cs.length; k++) {
        if (i === j || i === k) continue;
        const P = cs[i], A = cs[j], B = cs[k];
        const v1 = { x: A.x - P.x, y: A.y - P.y }, v2 = { x: B.x - P.x, y: B.y - P.y };
        const l1 = Math.hypot(v1.x, v1.y), l2 = Math.hypot(v2.x, v2.y);
        if (!l1 || !l2 || Math.abs(l1 - l2) > 0.25 * Math.max(l1, l2)) continue;
        const cosA = Math.abs(v1.x * v2.x + v1.y * v2.y) / (l1 * l2);
        if (cosA > 0.25) continue;
        const cross = v1.x * v2.y - v1.y * v2.x;   // orient TR/BL so cross(ex,ey) > 0 (y grows downward)
        triples.push({ P, TR: cross > 0 ? A : B, BL: cross > 0 ? B : A, str: P.n + A.n + B.n, cosA });
    }
    triples.sort((a, b) => (b.str - a.str) || (a.cosA - b.cosA));
    for (const t of triples.slice(0, 3)) {
        const r = _qrTryTriple(t.P, t.TR, t.BL, g, W, H);
        if (r !== null) return r;
    }
    return null;
}
// Attempt a full read for one finder-corner assignment: locate the alignment
// pattern (wide search -- strong keystone pushes it modules off the affine
// prediction), try homographies for the best candidates, finally plain affine.
// Every attempt ends at the RS gate: a wrong map is a miss, never a wrong read.
function _qrTryTriple(P, TR, BL, g, W, H) {
    const ex = { x: (TR.x - P.x) / 22, y: (TR.y - P.y) / 22 };   // finder centers are 22 modules apart
    const ey = { x: (BL.x - P.x) / 22, y: (BL.y - P.y) / 22 };
    const mapA = (mx, my) => [P.x + (mx - 3) * ex.x + (my - 3) * ey.x, P.y + (mx - 3) * ex.y + (my - 3) * ey.y];
    const dark = (px, py) => {
        const x = Math.round(px), y = Math.round(py);
        return x >= 0 && x < W && y >= 0 && y < H ? g[y * W + x] === 1 : false;
    };
    const RING = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    const cands = [];
    let alScore = 0, alN = 0, alX = 0, alY = 0;
    for (let oy = -3; oy <= 3; oy += 0.25) for (let ox = -3; ox <= 3; ox += 0.25) {
        const c = mapA(22 + ox, 22 + oy);
        let sc = dark(c[0], c[1]) ? 4 : 0;
        for (const [ax, ay] of RING) {
            const p1 = mapA(22 + ox + ax, 22 + oy + ay);
            if (!dark(p1[0], p1[1])) sc++;               // light ring at radius 1
            const p2 = mapA(22 + ox + 2 * ax, 22 + oy + 2 * ay);
            if (dark(p2[0], p2[1])) sc++;                // dark ring at radius 2
        }
        if (sc < 15) continue;
        cands.push({ sc, ox, oy });
        // Max-score offsets tie in a region symmetric around the true center:
        // their average is the best single estimate.
        if (sc > alScore) { alScore = sc; alN = 1; alX = ox; alY = oy; }
        else if (sc === alScore) { alN++; alX += ox; alY += oy; }
    }
    const tries = [];
    if (alScore >= 15) tries.push([alX / alN, alY / alN]);
    cands.sort((a, b) => b.sc - a.sc);
    for (const c of cands) {
        if (tries.length >= 5) break;
        if (tries.some(t => Math.abs(t[0] - c.ox) < 0.6 && Math.abs(t[1] - c.oy) < 0.6)) continue;
        tries.push([c.ox, c.oy]);
    }
    for (const [ox, oy] of tries) {
        const ap = mapA(22 + ox, 22 + oy);
        const hm = _homography([[3, 3], [25, 3], [3, 25], [22, 22]],
                               [[P.x, P.y], [TR.x, TR.y], [BL.x, BL.y], ap]);
        if (hm) {
            const r = _qrRead(hm, g, W, H);
            if (r !== null) return r;
        }
    }
    return _qrRead(mapA, g, W, H);   // flat pose: the affine map alone is exact
}
// Sample the grid through `map`, verify timing, extract + error-correct + parse.
// Returns the payload string, or null if this mapping does not yield a codeword.
function _qrRead(map, g, W, H) {
    const dark = (px, py) => {
        const x = Math.round(px), y = Math.round(py);
        return x >= 0 && x < W && y >= 0 && y < H ? g[y * W + x] === 1 : false;
    };
    // Sample each module as the majority of 5 probes around its center.
    const PROBES = [[0, 0], [0.28, 0], [-0.28, 0], [0, 0.28], [0, -0.28]];
    const m = [];
    for (let r = 0; r < QR_SIZE; r++) {
        m.push([]);
        for (let c = 0; c < QR_SIZE; c++) {
            let n = 0;
            for (const [ox, oy] of PROBES) {
                const p = map(c + ox, r + oy);
                if (dark(p[0], p[1])) n++;
            }
            m[r].push(n >= 3);
        }
    }
    // Cheap sanity: the timing row must alternate (one bad module tolerated --
    // the RS pass below is the real gate).
    let tbad = 0;
    for (let i = 8; i < 21; i++) if (m[6][i] !== (i % 2 === 0)) tbad++;
    if (tbad > 1) return null;
    // Extract codewords (unmask mask 0), error-correct, then parse.
    const total = (QR_DATA_CW + QR_ECC_CW) * 8;
    let cw = new Array(QR_DATA_CW + QR_ECC_CW).fill(0);
    let bi = 0;
    for (const [x, y] of _qrDataOrder()) {
        if (bi >= total) break;
        let bit = m[y][x];
        if ((x + y) % 2 === 0) bit = !bit;
        cw[bi >>> 3] = (cw[bi >>> 3] << 1) | (bit ? 1 : 0);
        bi++;
    }
    cw = _rsCorrect(cw);
    if (!cw) return null;
    // Byte-mode payload: 4-bit mode (must be 4), 8-bit count, then the bytes at a 4-bit offset.
    if ((cw[0] >>> 4) !== 4) return null;
    const len = ((cw[0] & 0x0F) << 4) | (cw[1] >>> 4);
    if (len > QR_DATA_CW - 2) return null;
    let out = '';
    for (let i = 0; i < len; i++) out += String.fromCharCode(((cw[i + 1] & 0x0F) << 4) | (cw[i + 2] >>> 4));
    return out;
}
