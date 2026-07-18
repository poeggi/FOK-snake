// ================================================================
// AUDIO ENGINE
// ================================================================
const Snd = (() => {
    // -- Private state ---------------------------------------------
    let _ctx = null;
    let _musicGain = null, _sfxGain = null;
    let _musicVol = 1.0, _sfxVol = 0.5;
    let _currentTrack = null, _channelState = [];
    let _musicIsPaused = false, _bgSuspended = false;
    let _seekProvider = null;   // () => shared-clock seek (s) for the current track, or null offline. Set by the game.
    let _musicAnchor = null;    // {t0, seekAbs} last seek: audio-time t0 was placed at shared position seekAbs. Read-only drift probe.
    let _duckF = 1;   // quit-dialog duck: persistent gain modifier every music/sfx writer applies
    let _noiseBuf = null;   // crash-noise buffer, generated once and shared (see sfx 'crash')

    // -- Music data ------------------------------------------------
    const SEQ = {
        ambient: { bpm: 85, channels: [
            { fn:'tri',  vol:0.26, notes:[
                [659,1],[784,1],[659,1],[523,1],
                [523,1.5],[0,0.5],[440,1],[0,1],
                [440,1],[523,1],[659,1],[523,1],
                [440,1],[0,1],[440,1],[0,1],
            ]},
            { fn:'bass', vol:0.16, notes:[ [131,4],[0,4],[220,4],[0,4] ]},
            { fn:'pad',  vol:0.09, notes:[
                [196,1],[262,1],[330,1],[0,1],
                [196,1],[262,1],[330,1],[0,1],
                [220,1],[262,1],[330,1],[0,1],
                [220,1],[262,1],[330,1],[0,1],
            ]},
        ]},
        game: { bpm: 188, channels: [
            { fn:'fat',  vol:0.28, notes:[
                [440,0.5],[0,0.25],[494,0.25],[523,0.5],[494,0.5],
                [440,1],[0,0.5],[440,0.5],
                [523,0.5],[0,0.25],[587,0.25],[659,0.5],[587,0.5],
                [523,1],[0,1],
                [587,0.5],[659,0.5],[587,0.5],[494,0.5],
                [440,1],[0,0.5],[392,0.5],
                [330,0.5],[392,0.5],[440,0.5],[494,0.5],
                [440,2],
            ]},
            { fn:'bass', vol:0.20, notes:[
                [110,1],[0,1],[110,1],[0,1],[131,1],[0,1],[131,1],[0,1],
                [147,1],[0,1],[147,1],[0,1],[165,1],[0,1],[110,2],
            ]},
            { fn:'stab', vol:0.10, notes:[
                [220,0.5],[0,1.5],[220,0.5],[0,1.5],
                [262,0.5],[0,1.5],[262,0.5],[0,1.5],
                [294,0.5],[0,1.5],[294,0.5],[0,1.5],
                [330,0.5],[0,1.5],[330,0.5],[0,1.5],
            ]},
        ]},
        classicMenu: { bpm: 60, channels: [
            { fn:'square', vol:0.30, notes:[
                [659,0.25],[784,0.25],[659,0.25],[523,0.25],
                [440,0.25],[523,0.25],[659,0.25],[587,0.25],
                [349,0.25],[440,0.25],[523,0.25],[440,0.25],
                [392,0.25],[494,0.25],[587,0.25],[494,0.25],
                [523,0.25],[659,0.25],[784,0.25],[659,0.25],
                [440,0.25],[659,0.25],[523,0.25],[440,0.25],
                [349,0.25],[392,0.25],[440,0.25],[494,0.25],
                [523,0.75],[0,0.25],
            ]},
            { fn:'tri', vol:0.20, notes:[
                [131,0.5],[0,0.5],[220,0.5],[0,0.5],[175,0.5],[0,0.5],
                [196,0.5],[0,0.5],[131,0.5],[0,0.5],[220,0.5],[0,0.5],
                [175,0.5],[0,0.5],[131,1.0],
            ]},
        ]},
        classicGame: { bpm: 80, channels: [
            { fn:'square', vol:0.30, notes:[
                [440,0.25],[0,0.125],[494,0.125],[523,0.25],[494,0.25],
                [440,0.5],[0,0.25],[440,0.25],
                [523,0.25],[0,0.125],[587,0.125],[659,0.25],[587,0.25],
                [523,0.5],[0,0.5],
                [587,0.25],[659,0.25],[587,0.25],[494,0.25],
                [440,0.5],[0,0.25],[392,0.25],
                [330,0.25],[392,0.25],[440,0.25],[494,0.25],
                [440,1.0],
            ]},
            { fn:'tri', vol:0.22, notes:[
                [110,0.5],[0,0.5],[110,0.5],[0,0.5],
                [131,0.5],[0,0.5],[131,0.5],[0,0.5],
                [147,0.5],[0,0.5],[147,0.5],[0,0.5],
                [165,0.5],[0,0.5],[110,1.0],
            ]},
        ]},
    };

    // -- Oscillator helpers ----------------------------------------
    function _tone(freq, when, dur, type, vol, detune, dest) {
        if (!_ctx || freq <= 0 || when < _ctx.currentTime - 0.12) return;
        const o = _ctx.createOscillator(), g = _ctx.createGain();
        o.type = type || 'square'; o.frequency.value = freq;
        if (detune) o.detune.value = detune;
        g.gain.setValueAtTime(0, when);
        g.gain.linearRampToValueAtTime(vol, when + Math.max(0.010, Math.min(0.020, dur * 0.15)));
        g.gain.exponentialRampToValueAtTime(0.001, when + Math.max(dur * 0.88, 0.02));
        o.connect(g); g.connect(dest || _musicGain);
        o.start(when); o.stop(when + dur + 0.02);
        o.onended = () => { o.disconnect(); g.disconnect(); };
    }

    function _fatTone(freq, when, dur, vol) {
        if (!_ctx || freq <= 0 || when < _ctx.currentTime - 0.12) return;
        _tone(freq, when, dur, 'square', vol * 0.50,  0, _musicGain);
        _tone(freq, when, dur, 'square', vol * 0.28,  8, _musicGain);
        _tone(freq, when, dur, 'square', vol * 0.22, -8, _musicGain);
    }

    function _schedNote(ch, freq, when, dur) {
        if (freq <= 0) return;
        if      (ch.fn === 'fat')    _fatTone(freq, when, dur, ch.vol);
        else if (ch.fn === 'tri')    _tone(freq, when, dur, 'triangle', ch.vol, 0);
        else if (ch.fn === 'square') _tone(freq, when, dur, 'square',   ch.vol, 0);
        else if (ch.fn === 'bass' || ch.fn === 'pad') _tone(freq, when, dur, 'sine', ch.vol, 0);
        else if (ch.fn === 'stab')   _tone(freq, when, dur, 'sawtooth', ch.vol, 0);
    }

    // Called whenever AC transitions to running (onstatechange OR resume().then()).
    // Idempotent: safe to call from both paths on the same resume event.
    function _onContextRunning() {
        if (!_ctx || !_currentTrack || !SEQ[_currentTrack] || _musicIsPaused) return;
        const now = _ctx.currentTime;
        // Re-anchor to the shared clock on the running transition. A pin made while the
        // context was suspended (autoplay gate on a fresh start, or a background) is stale
        // by however long we waited to resume -- the frozen audio clock did not advance
        // while the shared clock did. Re-seeking here is what lets a just-started client
        // line up with an already-running reference; without it the offset was whatever
        // the suspend happened to last, so it looked random from one restart to the next.
        const seekSec = _seekProvider ? _seekProvider(_currentTrack) : null;
        if (seekSec != null && seekSec > 0)
            _channelState = _seekChannels(SEQ[_currentTrack], 60 / SEQ[_currentTrack].bpm, now, seekSec);
        if (_bgSuspended) {
            _bgSuspended = false;
            // Drop the pre-suspend look-ahead so queued notes do not replay in a burst on
            // return (the other half of the metallic artifact). If there was no shared clock
            // to re-seek to, at least schedule fresh from now. Same idea as musicGameUnpause.
            if (!(seekSec > 0)) _channelState.forEach(s => { s.nextNote = now + 0.05; });
            _musicGain.gain.cancelScheduledValues(now);
            _musicGain.gain.setValueAtTime(0, now);
            _musicGain.gain.setTargetAtTime(0.5 * _musicVol * _duckF, now, 0.02);
            return;
        }
        _musicGain.gain.cancelScheduledValues(now);
        _musicGain.gain.setValueAtTime(0.5 * _musicVol * _duckF, now);
    }

    // -- Audio context lifecycle -----------------------------------

    function audioInit() {
        // Build the permanent audio graph. Called at load; AC starts suspended.
        // Fire-and-forget resume() knocks on the OS audio door immediately.
        if (_ctx) return;
        try {
            // latencyHint 1/60s: ask for output buffering matched to the engine tick. It is a
            // HINT -- the browser clamps to what the hardware supports (often more on mobile),
            // so it minimises/steadies latency rather than guaranteeing 16.7ms. Older engines
            // reject a constructor arg, so fall back to the no-arg form.
            const _AC = window.AudioContext || window.webkitAudioContext;
            try { _ctx = new _AC({ latencyHint: 1/60 }); } catch(_e) { _ctx = new _AC(); }
            _musicGain = _ctx.createGain(); _musicGain.gain.value = 0; _musicGain.connect(_ctx.destination);
            _sfxGain = _ctx.createGain(); _sfxGain.gain.value = 0.5 *_sfxVol; _sfxGain.connect(_ctx.destination);
            _ctx.onstatechange = () => { if (_ctx.state === 'running') _onContextRunning(); };
            //_ctx.resume().catch(() => {});
        } catch(e) { _ctx = null; }
    }

    function audioPreWarm() {
        // Prime the AC at load: fire a silent buffer to register audio work with the
        // browser, attempt resume, then suspend so the next gesture does a real resume.
        if (!_ctx) return;
        // 1-sample silent buffer: iOS hint that this context has audio work
        const buf = _ctx.createBuffer(1, 1, 22050), src = _ctx.createBufferSource();
        src.buffer = buf; src.connect(_ctx.destination); src.start(0);
        //_ctx.resume().catch(() => {});
        //_ctx.suspend().catch(() => {});
    }

    function audioResume() {
        // Call from every user gesture. iOS cold-start silently hangs the first resume();
        // retrying on each gesture is safe (spec-idempotent). Both .then() and onstatechange
        // call _onContextRunning; whichever fires first wins, second is a no-op.
        if (_ctx) {
            return _ctx.resume().then(_onContextRunning).catch(() => {});
        }
        return Promise.resolve();
    }

    function audioBgSuspend() {
        // App backgrounding. On iOS the OS INTERRUPTS the context almost immediately, and any
        // notes still in the 400ms scheduler look-ahead then render against a frozen sample
        // clock -- the "metallic" artifact. So freeze FAST: hard-mute (an imperceptible click
        // as we leave the app) and suspend SYNCHRONOUSLY in the same event, before the OS gets
        // there. The old path (0.02s fade + a 120ms delayed suspend) lost that race and glitched.
        if (!_ctx || _ctx.state !== 'running') return;
        _bgSuspended = true;
        try { _musicGain.gain.cancelScheduledValues(_ctx.currentTime); _musicGain.gain.setValueAtTime(0, _ctx.currentTime); } catch(e) {}
        try { _ctx.suspend(); } catch(e) {}
    }

    // -- Music -----------------------------------------------------

    // Per-channel start state for a track seeked to `seekSec` (a shared-clock position
    // in seconds), anchored at audio-clock `t0`. The sound we schedule at t0 is not
    // HEARD until the context's output latency later, so we seek that much further
    // ahead -- otherwise the SOUND lands late by one buffer. Both clients walk the same
    // notes with the same (compensated) seek, so both land on the same pos.
    function _seekChannels(seq, spb, t0, seekSec) {
        const outLat = _ctx.outputLatency || _ctx.baseLatency || 0;
        const seek = seekSec > 0 ? seekSec + outLat : 0;
        // Record the anchor for musicDriftMs (measurement only -- does NOT change scheduling):
        // "audio-time t0 carries shared position seek". seek already includes the outLat
        // compensation, so a fresh anchor reads ~0 drift against getOutputTimestamp.
        _musicAnchor = seek > 0 ? { t0, seekAbs: seek } : null;
        return seq.channels.map(ch => {
            const loop = ch.notes.reduce((a, n) => a + n[1] * spb, 0);
            if (!(seek > 0) || !(loop > 0)) return { pos: 0, nextNote: t0 };
            let into = seek % loop, pos = 0;
            while (into >= ch.notes[pos][1] * spb) { into -= ch.notes[pos][1] * spb; pos = (pos + 1) % ch.notes.length; }
            return { pos, nextNote: t0 + (ch.notes[pos][1] * spb - into) };
        });
    }
    function musicPlay(trackId, fadeSec, seekSec) {
        // Start a music track. No-op if already playing this track. With fadeSec the
        // gain ramps from its current level to nominal (menu entry uses 0.5s); without,
        // it is set instantly (game track punches in at GO).
        //
        // seekSec starts the track where it WOULD be had it begun that long ago. An
        // online duel passes the time since the shared start PTS, so both clients drop
        // into the same bar of the same loop no matter which one got there first --
        // the track is a function of the shared clock, not of when this tab happened
        // to reach the phase. Both sides then hear one performance, not two.
        //
        // If the context is still SUSPENDED here (autoplay gate), t0 = currentTime is
        // frozen and this pin goes stale by however long we wait to resume -- so
        // _onContextRunning re-seeks from the live provider on the running transition.
        if (!_ctx || _currentTrack === trackId) return;
        _currentTrack = trackId; _musicIsPaused = false;
        const _seq = SEQ[trackId], _spb = 60 / _seq.bpm, _t0 = _ctx.currentTime;
        _channelState = _seekChannels(_seq, _spb, _t0, seekSec);
        // Set gain unconditionally: on a suspended AC, setValueAtTime at the frozen
        // currentTime applies immediately when AC resumes and time advances past it.
        _musicGain.gain.cancelScheduledValues(_ctx.currentTime);
        if (fadeSec) {
            _musicGain.gain.setValueAtTime(Math.max(0, _musicGain.gain.value || 0), _ctx.currentTime);
            _musicGain.gain.setTargetAtTime(0.5 * _musicVol * _duckF, _ctx.currentTime, fadeSec / 3);
        } else {
            _musicGain.gain.setValueAtTime(0.5 * _musicVol * _duckF, _ctx.currentTime);
        }
    }

    function musicStop() {
        _currentTrack = null; _musicIsPaused = false;
        if (_ctx && _musicGain) {
            _musicGain.gain.cancelScheduledValues(_ctx.currentTime);
            _musicGain.gain.setTargetAtTime(0, _ctx.currentTime, 0.04);
        }
    }

    function duck(on) {
        // Temporary 50% level on music + sfx (the in-game quit dialog). Music is only
        // touched while actually playing (a paused track stays silent); restore returns
        // both to their configured volumes. _duckF is applied by EVERY gain writer, so
        // re-raises (e.g. a respawn's munpause behind the dialog) cannot bypass it.
        _duckF = on ? 0.5 : 1;
        if (!_ctx) return;
        if (_musicGain && _currentTrack && !_musicIsPaused) {
            _musicGain.gain.cancelScheduledValues(_ctx.currentTime);
            _musicGain.gain.setTargetAtTime(0.5 * _musicVol * _duckF, _ctx.currentTime, 0.04);
        }
        if (_sfxGain) _sfxGain.gain.setTargetAtTime(0.5 * _sfxVol * _duckF, _ctx.currentTime, 0.04);
    }

    function musicFadeOut(sec) {
        // Like musicStop, but with a caller-chosen fade to silence (~sec). Already-
        // scheduled notes (0.4s lookahead) decay under the envelope -- no clicks.
        _currentTrack = null; _musicIsPaused = false;
        if (_ctx && _musicGain) {
            _musicGain.gain.cancelScheduledValues(_ctx.currentTime);
            _musicGain.gain.setTargetAtTime(0, _ctx.currentTime, (sec || 0.5) / 3);
        }
    }

    function musicGamePause() {
        if (!_ctx || !_currentTrack) return;
        _musicIsPaused = true;
        _musicGain.gain.cancelScheduledValues(_ctx.currentTime);
        _musicGain.gain.setTargetAtTime(0, _ctx.currentTime, 0.04);
    }

    function musicGameUnpause() {
        if (!_ctx || !_currentTrack || !_musicIsPaused) return;   // only resume if actually paused
        _musicIsPaused = false;
        const now = _ctx.currentTime;
        _channelState.forEach(s => { s.nextNote = now + 0.05; });
        _musicGain.gain.cancelScheduledValues(now);
        _musicGain.gain.setValueAtTime(0.5 * _musicVol * _duckF, now);
    }

    function musicSetVolume(vol) {
        _musicVol = vol;
        if (_musicGain && _currentTrack && !_musicIsPaused && _ctx && _ctx.state === 'running') {
            _musicGain.gain.cancelScheduledValues(_ctx.currentTime);
            _musicGain.gain.setValueAtTime(0.5 * vol * _duckF, _ctx.currentTime);
        }
    }

    function musicTick(musicEnabled) {
        if (!_ctx || !_currentTrack || !musicEnabled || _musicIsPaused) return;
        if (_ctx.state !== 'running') return;
        const seq = SEQ[_currentTrack], spb = 60 / seq.bpm;
        seq.channels.forEach((ch, ci) => {
            const st = _channelState[ci];
            if (st.nextNote < _ctx.currentTime) st.nextNote = _ctx.currentTime;
            while (st.nextNote < _ctx.currentTime + 0.40) {
                const [f, b] = ch.notes[st.pos];
                _schedNote(ch, f, st.nextNote, b * spb * 0.84);
                st.nextNote += b * spb;
                st.pos = (st.pos + 1) % ch.notes.length;
            }
        });
    }

    // -- SFX -------------------------------------------------------

    function ctxTime(){ return _ctx ? _ctx.currentTime : null; }
    // DEBUG (read-only): signed ms the music scheduler LEADS(+)/LAGS(-) the shared clock.
    // getOutputTimestamp() gives the audio-clock time (contextTime) of the sample AT THE
    // SPEAKER right now, correlated to real time -- so this measures the true acoustic
    // position without an outputLatency estimate or a currentTime/Date.now cross-sample.
    // The scheduler PROMISED audio-time contextTime is heard when the shared clock reads
    // seekAbs + (contextTime - t0); reality is it is heard NOW (shared = provider). The gap
    // is the drift. null when unsynced, no track, or the API is unavailable (iOS/suspended).
    function musicDriftMs(){
        if(!_ctx || !_currentTrack || !_musicAnchor || !_seekProvider) return null;
        const ts = _ctx.getOutputTimestamp ? _ctx.getOutputTimestamp() : null;
        if(!ts || !(ts.contextTime > 0)) return null;
        const sNow = _seekProvider(_currentTrack);
        if(sNow == null || !(sNow > 0)) return null;
        return (_musicAnchor.seekAbs + (ts.contextTime - _musicAnchor.t0) - sNow) * 1000;
    }
    function sfxPlay(type, on = true, when = null) {
        // on: pass cfg.music to gate playback on the sound-enabled setting.
        // when: absolute AudioContext time to start at (sample-accurate, per the
        // server contract's WebAudio scheduling rule); absent/past = immediately.
        if (!_ctx || !on) return;
        const now = (when != null && when > _ctx.currentTime) ? when : _ctx.currentTime;
        const t = (f, w, d, tp) => _tone(f, w, d, tp || 'square', 0.42, 0, _sfxGain);
        if (type === 'eat') {
            t(880, now, 0.05); t(1108, now + 0.055, 0.06);
        } else if (type === 'die') {
            for (let i = 0; i < 7; i++) t(300 - i * 26, now + i * 0.07, 0.1, 'sawtooth');
        } else if (type === 'levelUp') {
            [523,659,784,988,1319].forEach((f,i) => t(f, now + i*0.09, 0.13));
        } else if (type === 'nav') {
            t(392, now, 0.03);
        } else if (type === 'select') {
            t(523, now, 0.04); t(659, now + 0.045, 0.08);
        } else if (type === 'bonus') {
            [880,1047,1319,1568].forEach((f,i) => t(f, now + i*0.055, 0.10));
        } else if (type === 'perfect') {
            [523,659,784,1047,1319,1568].forEach((f,i) => t(f, now + i*0.07, 0.22));
            [784,988,1319].forEach(f => t(f, now + 0.50, 0.30, 'triangle'));
        } else if (type === 'unbox') {
            // Golden unbox: a quick rising sparkle then a bright shimmering chord.
            [659,988,1319,1760].forEach((f,i) => t(f, now + i*0.05, 0.10));
            [1319,1760,2637].forEach(f => t(f, now + 0.24, 0.30, 'triangle'));
        } else if (type === 'lucky_spawn') {
            [880,1319,1568].forEach((f,i) => t(f, now + i*0.055, 0.13));
        } else if (type === 'lucky_eat') {
            [880,1047,1319,1568,2093].forEach((f,i) => t(f, now + i*0.045, 0.16));
        } else if (type === 'epic_spawn') {
            [440,554,659,880,1047,1319,1568].forEach((f,i) => t(f, now + i*0.06, 0.18));
            t(1568, now + 0.46, 0.28, 'triangle');
        } else if (type === 'epic_eat') {
            [523,659,784,1047,1319,1568,2093].forEach((f,i) => t(f, now + i*0.055, 0.24));
            [784,988,1319,1568].forEach(f => t(f, now + 0.45, 0.36, 'triangle'));
        } else if (type === 'coin') {
            // Deliberately not mute-gated (it doubles as the audio-unlock ping in the
            // splash-exit gesture) -- so stay discreet: half the normal sfx amplitude.
            const tq = (f, w, d) => _tone(f, w, d, 'square', 0.21, 0, _sfxGain);
            tq(1568, now, 0.03); tq(1319, now + 0.045, 0.04); tq(880, now + 0.095, 0.08);
        } else if (type === 'fail') {
            t(330, now, 0.05, 'sawtooth'); t(196, now + 0.06, 0.12, 'sawtooth');
        } else if (type === 'crash') {
            const dur = 0.22;
            if (!_noiseBuf) {
                // Generated once from a FIXED-SEED PRNG (mulberry32, like the sim) into a fixed
                // 44100Hz buffer: the noise is bit-identical on every platform and run; the
                // BufferSource resamples to the device rate on playback.
                _noiseBuf = _ctx.createBuffer(1, Math.ceil(44100 * dur), 44100);
                const data = _noiseBuf.getChannelData(0);
                let s = 0xC0FFEE | 0;
                for (let i = 0; i < data.length; i++) {
                    s = (s + 0x6D2B79F5) | 0;
                    let t = Math.imul(s ^ (s >>> 15), 1 | s);
                    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
                    data[i] = (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
                }
            }
            const src = _ctx.createBufferSource();
            src.buffer = _noiseBuf;
            const flt = _ctx.createBiquadFilter();
            flt.type = 'bandpass'; flt.frequency.value = 380; flt.Q.value = 0.6;
            const g = _ctx.createGain();
            g.gain.setValueAtTime(0.9, now);
            g.gain.exponentialRampToValueAtTime(0.001, now + dur);
            src.connect(flt); flt.connect(g); g.connect(_sfxGain);
            src.start(now); src.stop(now + dur);
            src.onended = () => { src.disconnect(); flt.disconnect(); g.disconnect(); };
            t(140, now, 0.14, 'sawtooth');
            t(95,  now + 0.055, 0.11, 'sawtooth');
        }
    }

    function sfxSetVolume(vol) {
        _sfxVol = vol;
        if (_sfxGain) _sfxGain.gain.value = 0.5 * vol * _duckF;
    }

    // Build graph and prime pipeline at load. AC is suspended; prewarm oscillators
    // fire the moment the AC first resumes from a user gesture.
    audioInit();
    //audioPreWarm();

    return {
        audioInit, audioResume, audioBgSuspend,
        musicPlay, musicStop, musicFadeOut, duck, musicGamePause, musicGameUnpause, musicSetVolume, musicTick,
        setMusicSeekProvider: (fn) => { _seekProvider = fn; },
        sfxPlay, sfxSetVolume, ctxTime, musicDriftMs,
        audioPreWarm,
    };
})();
