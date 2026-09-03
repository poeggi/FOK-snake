// ============================================================================
// hmac.js -- SHA-256 and HMAC-SHA256, SYNCHRONOUSLY, in plain 32-bit integer JS.
//
// WebCrypto has both and is faster, but it is async: the item-attestation tag is
// computed INSIDE the duel's lockstep tick, on the same tick that emits the 1Hz
// hash packet (duel-core.js), and there is no await to be had in a deterministic
// sim step. So the primitive has to be synchronous, which means it has to be here.
//
// The tag is what the server verifies with hash_hmac('sha256', ..) truncated to
// 16 hex (FOK-server public/src/Ledger.php::mac), so this file's output must match
// that byte for byte. The pre-image and the truncation live in itemTag() below --
// ONE place, so the client and the server can only ever disagree by a real edit.
//
// Loaded by BOTH homes: index.html for the main-thread sim, and importScripts in
// sim-worker.js for the worker-hosted one. No DOM, no storage, no globals beyond
// the four functions.
// ============================================================================

// The 64 SHA-256 round constants. Int32Array, so the ones past 2^31 are negative
// here and the whole compression runs in |0 arithmetic -- no float rounding, no
// BigInt, exactly what a 32-bit ARM phone core does fastest.
const _SHA_K = new Int32Array([
    0x428a2f98|0, 0x71374491|0, 0xb5c0fbcf|0, 0xe9b5dba5|0, 0x3956c25b|0, 0x59f111f1|0, 0x923f82a4|0, 0xab1c5ed5|0,
    0xd807aa98|0, 0x12835b01|0, 0x243185be|0, 0x550c7dc3|0, 0x72be5d74|0, 0x80deb1fe|0, 0x9bdc06a7|0, 0xc19bf174|0,
    0xe49b69c1|0, 0xefbe4786|0, 0x0fc19dc6|0, 0x240ca1cc|0, 0x2de92c6f|0, 0x4a7484aa|0, 0x5cb0a9dc|0, 0x76f988da|0,
    0x983e5152|0, 0xa831c66d|0, 0xb00327c8|0, 0xbf597fc7|0, 0xc6e00bf3|0, 0xd5a79147|0, 0x06ca6351|0, 0x14292967|0,
    0x27b70a85|0, 0x2e1b2138|0, 0x4d2c6dfc|0, 0x53380d13|0, 0x650a7354|0, 0x766a0abb|0, 0x81c2c92e|0, 0x92722c85|0,
    0xa2bfe8a1|0, 0xa81a664b|0, 0xc24b8b70|0, 0xc76c51a3|0, 0xd192e819|0, 0xd6990624|0, 0xf40e3585|0, 0x106aa070|0,
    0x19a4c116|0, 0x1e376c08|0, 0x2748774c|0, 0x34b0bcb5|0, 0x391c0cb3|0, 0x4ed8aa4a|0, 0x5b9cca4f|0, 0x682e6ff3|0,
    0x748f82ee|0, 0x78a5636f|0, 0x84c87814|0, 0x8cc70208|0, 0x90befffa|0, 0xa4506ceb|0, 0xbef9a3f7|0, 0xc67178f2|0
]);
const _SHA_H0 = new Int32Array([
    0x6a09e667|0, 0xbb67ae85|0, 0x3c6ef372|0, 0xa54ff53a|0, 0x510e527f|0, 0x9b05688c|0, 0x1f83d9ab|0, 0x5be0cd19|0
]);
// Scratch, reused across calls: the message schedule is the only per-block array
// and this runs once a second inside a sim tick, so it must not allocate.
const _SHA_W = new Int32Array(64);

// UTF-8 bytes of a string. Every pre-image this file hashes is ASCII by
// construction (hex, ids, decimal ticks), but encoding properly costs nothing and
// keeps the function honest if a caller ever passes something else.
function _shaBytes(s){
    const n = s.length, out = [];
    for(let i = 0; i < n; i++){
        let c = s.charCodeAt(i);
        if(c < 0x80) out.push(c);
        else if(c < 0x800){ out.push(0xc0 | (c >> 6), 0x80 | (c & 63)); }
        else if(c >= 0xd800 && c < 0xdc00 && i + 1 < n){
            // Surrogate pair -> one code point.
            c = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(++i) - 0xdc00);
            out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        }
        else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
}

// The digest of a byte array, as 32 raw bytes. Textbook FIPS 180-4: pad with 0x80,
// zeros, then the bit length big-endian in the last 8 bytes.
function sha256Bytes(msg){
    const l = msg.length, total = (((l + 8) >> 6) + 1) << 6;
    const p = new Uint8Array(total);
    p.set(msg); p[l] = 0x80;
    // Bit length as a big-endian 64-bit field. l*8 can exceed 32 bits in theory;
    // the high word is l >>> 29, which is exact for any array this engine can hold.
    const bits = l * 8;
    p[total - 5] = (l >>> 29) & 0xff;
    p[total - 4] = (bits >>> 24) & 0xff;
    p[total - 3] = (bits >>> 16) & 0xff;
    p[total - 2] = (bits >>> 8) & 0xff;
    p[total - 1] = bits & 0xff;

    let h0 = _SHA_H0[0], h1 = _SHA_H0[1], h2 = _SHA_H0[2], h3 = _SHA_H0[3];
    let h4 = _SHA_H0[4], h5 = _SHA_H0[5], h6 = _SHA_H0[6], h7 = _SHA_H0[7];
    const w = _SHA_W;
    for(let i = 0; i < total; i += 64){
        for(let j = 0; j < 16; j++){
            const o = i + j * 4;
            w[j] = (p[o] << 24) | (p[o+1] << 16) | (p[o+2] << 8) | p[o+3];
        }
        for(let j = 16; j < 64; j++){
            const x = w[j-15], y = w[j-2];
            const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
            const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
            w[j] = (w[j-16] + s0 + w[j-7] + s1) | 0;
        }
        let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
        for(let j = 0; j < 64; j++){
            const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
            const t1 = (h + S1 + ((e & f) ^ (~e & g)) + _SHA_K[j] + w[j]) | 0;
            const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
            const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
            h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
        }
        h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
        h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
    }
    const out = new Uint8Array(32), hs = [h0, h1, h2, h3, h4, h5, h6, h7];
    for(let i = 0; i < 8; i++){
        out[i*4]   = (hs[i] >>> 24) & 0xff; out[i*4+1] = (hs[i] >>> 16) & 0xff;
        out[i*4+2] = (hs[i] >>> 8)  & 0xff; out[i*4+3] =  hs[i]         & 0xff;
    }
    return out;
}

const _HEX = '0123456789abcdef';
function _bytesHex(b){
    let s = '';
    for(let i = 0; i < b.length; i++) s += _HEX[(b[i] >> 4) & 15] + _HEX[b[i] & 15];
    return s;
}
// Hex string -> bytes. An odd length or a non-hex digit yields null: a malformed
// secret must never silently key a tag the server would then reject as tampering.
function _hexBytes(s){
    if(typeof s !== 'string' || s.length === 0 || (s.length & 1)) return null;
    const out = new Uint8Array(s.length >> 1);
    for(let i = 0; i < out.length; i++){
        const v = parseInt(s.substr(i * 2, 2), 16);
        if(!(v >= 0 && v <= 255)) return null;
        out[i] = v;
    }
    return out;
}

// The lowercase hex digest of a string. Used for the ownership digest that both
// clients attest to: it must be short and bounded (the server caps ws_digest at
// 256 chars), and a hash is both by construction.
function sha256Hex(s){ return _bytesHex(sha256Bytes(_shaBytes(s))); }

// HMAC-SHA256 with a raw-byte key, hex out. Standard ipad/opad construction.
function hmacSha256Hex(keyBytes, msg){
    let k = keyBytes;
    if(k.length > 64) k = sha256Bytes(k);
    const ip = new Uint8Array(64), op = new Uint8Array(64);
    for(let i = 0; i < 64; i++){
        const b = i < k.length ? k[i] : 0;
        ip[i] = b ^ 0x36; op[i] = b ^ 0x5c;
    }
    const m = _shaBytes(msg);
    const inner = new Uint8Array(64 + m.length);
    inner.set(ip); inner.set(m, 64);
    const ih = sha256Bytes(inner);
    const outer = new Uint8Array(96);
    outer.set(op); outer.set(ih, 64);
    return _bytesHex(sha256Bytes(outer));
}

// The item-attestation tag. THE contract with the server: the pre-image is
// mid | tick | ws_digest joined by a single '|' (a byte none of the three fields
// can contain, so the concatenation is unambiguous), keyed with the per-match
// secret as RAW BYTES from its hex, truncated to the first 16 hex digits = 64
// bits. Mirrors Ledger::mac exactly; changing either end breaks every claim.
// '' when the secret is missing or malformed -- the caller then simply has no tag
// to send, which is a claim the server holds, not a claim it rejects.
const ITEM_TAG_SEP = '|';
function itemTag(secretHex, mid, tick, wsDigest){
    const k = _hexBytes(secretHex);
    if(!k) return '';
    return hmacSha256Hex(k, mid + ITEM_TAG_SEP + tick + ITEM_TAG_SEP + wsDigest).slice(0, 16);
}
