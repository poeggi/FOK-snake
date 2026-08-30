// Offline renderer for the game music: turns a SEQ track from js/audio.js into a WAV
// master, which ffmpeg then encodes to the .m4r ringtone shipped in docs/.
//
//   node test/render-theme.js game 6 docs/snake-theme.wav
//   wsl -d Ubuntu-22.04 ffmpeg -y -i docs/snake-theme.wav -c:a aac -b:a 128k \
//       -movflags +faststart docs/snake-theme.m4r
//
// It lives under test/ ON PURPOSE: the pre-commit hook builds sw.js ASSETS from every
// tracked .js outside test/ and .github/, so a tools/ copy would be precached by the
// service worker as if it were game code.
//
// The note tables are READ from js/audio.js, never copied -- the music has one source of
// truth. The synthesis below mirrors Snd's _tone/_fatTone/_schedNote/musicTick exactly
// (envelope shape, the 0.84 note length, the fat-square detune stack); Node has no Web
// Audio, so it is reimplemented rather than shared. Keep the two in step.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SR = 44100;
const NOTE_LEN = 0.84;    // musicTick(): a note sounds for 0.84 of its slot
const TABLE = 2048;       // single-cycle wavetable resolution
const PEAK = 0.95;        // ringtones want level: peak-normalise (the game's 0.5 master gain is a constant, so normalising simply replaces it)

// The SEQ literal, lifted out of the audio engine by brace matching (it is a plain data
// table with no strings that could carry a brace).
function readSeq() {
    const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'audio.js'), 'utf8');
    const at = src.indexOf('const SEQ = {');
    if (at < 0) throw new Error('js/audio.js: the SEQ table is gone');
    const open = src.indexOf('{', at);
    let depth = 0, i = open;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) break;
    }
    return vm.runInNewContext('(' + src.slice(open, i + 1) + ')');
}

// Band-limited single cycle, like the browser's built-in oscillator types: harmonics only
// up to Nyquist, so the render does not alias the way a naive square/saw would.
const _tables = new Map();
function wavetable(type, freq) {
    const maxH = Math.max(1, Math.floor((SR / 2) / freq));
    const key = type + ':' + maxH;
    const hit = _tables.get(key);
    if (hit) return hit;
    const t = new Float32Array(TABLE);
    for (let i = 0; i < TABLE; i++) {
        const ph = 2 * Math.PI * i / TABLE;
        let v = 0;
        if (type === 'sine') v = Math.sin(ph);
        else if (type === 'square')   { for (let k = 1; k <= maxH; k += 2) v += Math.sin(k * ph) / k; v *= 4 / Math.PI; }
        else if (type === 'sawtooth') { for (let k = 1; k <= maxH; k++) v += (k % 2 ? 1 : -1) * Math.sin(k * ph) / k; v *= 2 / Math.PI; }
        else if (type === 'triangle') { for (let k = 1; k <= maxH; k += 2) v += (((k - 1) / 2) % 2 ? -1 : 1) * Math.sin(k * ph) / (k * k); v *= 8 / (Math.PI * Math.PI); }
        t[i] = v;
    }
    _tables.set(key, t);
    return t;
}

// One voice = Snd._tone: a fresh oscillator at phase 0, gain 0 -> vol over the attack,
// then an exponential fall to 0.001 by dur*0.88, the oscillator stopping dur+0.02 in.
function addTone(buf, freq, when, dur, type, vol, detune) {
    if (freq <= 0) return;
    const f = detune ? freq * Math.pow(2, detune / 1200) : freq;
    const tbl = wavetable(type, f);
    const atk = Math.max(0.010, Math.min(0.020, dur * 0.15));
    const dec = Math.max(dur * 0.88, 0.02);
    const n = Math.ceil((dur + 0.02) * SR);
    const step = f * TABLE / SR;
    const i0 = Math.round(when * SR);
    let ph = 0;
    for (let i = 0; i < n; i++) {
        const o = i0 + i;
        if (o >= buf.length) break;
        const t = i / SR;
        const g = t < atk ? vol * (t / atk)
                : t < dec ? vol * Math.pow(0.001 / vol, (t - atk) / (dec - atk))
                : 0.001;
        const a = ph | 0, b = (a + 1) % TABLE;
        buf[o] += (tbl[a] + (tbl[b] - tbl[a]) * (ph - a)) * g;
        ph += step;
        if (ph >= TABLE) ph -= TABLE;
    }
}

// Snd._schedNote: the channel fn picks the waveform ('fat' stacks three detuned squares).
function schedNote(buf, ch, freq, when, dur) {
    if (ch.fn === 'fat') {
        addTone(buf, freq, when, dur, 'square', ch.vol * 0.50,  0);
        addTone(buf, freq, when, dur, 'square', ch.vol * 0.28,  8);
        addTone(buf, freq, when, dur, 'square', ch.vol * 0.22, -8);
    }
    else if (ch.fn === 'tri')    addTone(buf, freq, when, dur, 'triangle', ch.vol, 0);
    else if (ch.fn === 'square') addTone(buf, freq, when, dur, 'square',   ch.vol, 0);
    else if (ch.fn === 'bass' || ch.fn === 'pad') addTone(buf, freq, when, dur, 'sine', ch.vol, 0);
    else if (ch.fn === 'stab')   addTone(buf, freq, when, dur, 'sawtooth', ch.vol, 0);
    else throw new Error('unknown channel fn: ' + ch.fn);
}

function render(seq, loops, fadeSec) {
    const spb = 60 / seq.bpm;
    // Each channel walks and wraps its OWN pattern, exactly as musicTick does.
    const loopSec = Math.max(...seq.channels.map(ch => ch.notes.reduce((a, n) => a + n[1], 0) * spb));
    const total = loopSec * loops;
    const buf = new Float32Array(Math.ceil((total + 0.5) * SR));   // headroom: the last notes ring past the cut
    for (const ch of seq.channels) {
        let when = 0, pos = 0;
        while (when < total) {
            const note = ch.notes[pos];
            if (note[0] > 0) schedNote(buf, ch, note[0], when, note[1] * spb * NOTE_LEN);
            when += note[1] * spb;
            pos = (pos + 1) % ch.notes.length;
        }
    }
    const out = buf.subarray(0, Math.round(total * SR));
    let peak = 0;
    for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
    const gain = peak > 0 ? PEAK / peak : 1;
    const fade = Math.round(fadeSec * SR);
    for (let i = 0; i < out.length; i++) {
        const left = out.length - i;
        out[i] *= gain * (left < fade ? left / fade : 1);
    }
    return { pcm: out, loopSec, total, peak };
}

function writeWav(file, pcm) {
    const head = Buffer.alloc(44);
    head.write('RIFF', 0); head.writeUInt32LE(36 + pcm.length * 2, 4); head.write('WAVE', 8);
    head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20);
    head.writeUInt16LE(1, 22); head.writeUInt32LE(SR, 24); head.writeUInt32LE(SR * 2, 28);
    head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
    head.write('data', 36); head.writeUInt32LE(pcm.length * 2, 40);
    const body = Buffer.alloc(pcm.length * 2);
    for (let i = 0; i < pcm.length; i++) body.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767))), i * 2);
    fs.writeFileSync(file, Buffer.concat([head, body]));
}

const args = process.argv.slice(2);
const SEQ = readSeq();
const track = args[0];
if (!track || !SEQ[track]) {
    console.error('usage: node test/render-theme.js <' + Object.keys(SEQ).join('|') + '> [loops] [out.wav]');
    process.exit(2);
}
const loops = Number(args[1]) || 6;
const out = args[2] || ('docs/' + track + '.wav');
const r = render(SEQ[track], loops, 1.5);
writeWav(out, r.pcm);
console.log(track + ': ' + SEQ[track].bpm + 'bpm, loop ' + r.loopSec.toFixed(2) + 's x' + loops
    + ' = ' + r.total.toFixed(2) + 's, synth peak ' + r.peak.toFixed(3) + ' -> normalised ' + PEAK
    + ', ' + r.pcm.length + ' samples -> ' + out);
