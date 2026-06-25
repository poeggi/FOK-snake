// ================================================================
// AUDIO ENGINE
// ================================================================
const Snd = (() => {
    // ── Private state ─────────────────────────────────────────────
    let _ctx = null;
    let _musicGain = null, _sfxGain = null;
    let _musicVol = 1.0, _sfxVol = 0.5;
    let _currentTrack = null, _channelState = [];
    let _musicIsPaused = false, _bgSuspended = false;

    // ── Music data ────────────────────────────────────────────────
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

    // ── Oscillator helpers ────────────────────────────────────────
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
        const flush = _bgSuspended ? 0.45 : 0.05;
        _bgSuspended = false;
        _channelState = SEQ[_currentTrack].channels.map(() => ({ pos: 0, nextNote: _ctx.currentTime + flush }));
        _musicGain.gain.cancelScheduledValues(_ctx.currentTime);
        _musicGain.gain.setValueAtTime(0.32 * _musicVol, _ctx.currentTime);
    }

    // ── Audio context lifecycle ───────────────────────────────────

    function audioInit() {
        // Create AudioContext. Must be called from a trusted user gesture.
        if (_ctx) return;
        try {
            _ctx = new (window.AudioContext || window.webkitAudioContext)();
            _musicGain = _ctx.createGain(); _musicGain.gain.value = 0; _musicGain.connect(_ctx.destination);
            _sfxGain = _ctx.createGain(); _sfxGain.gain.value = 0.58 * _sfxVol; _sfxGain.connect(_ctx.destination);
            _ctx.onstatechange = () => { if (_ctx.state === 'running') _onContextRunning(); };
            // 1-sample silent buffer: prompts iOS to treat this context as user-gesture-unlocked
            const buf = _ctx.createBuffer(1, 1, 22050), src = _ctx.createBufferSource();
            src.buffer = buf; src.connect(_ctx.destination); src.start(0);
        } catch(e) { _ctx = null; }
    }

    function audioResume() {
        // Resume suspended AC (or create it). Call from every trusted user gesture.
        // iOS cold-start silently hangs the first ac.resume(); retrying on each gesture
        // is safe (spec-idempotent). Both .then() and onstatechange call _onContextRunning,
        // so whichever fires first wins; the second call is a harmless no-op.
        if (!_ctx) audioInit();
        if (_ctx && _ctx.state === 'suspended') {
            _ctx.resume().then(_onContextRunning).catch(() => {});
        }
    }

    function audioTryResume() {
        // Resume without creating AC. Safe for untrusted events (touchend, pointerdown, etc.)
        if (_ctx && _ctx.state === 'suspended') {
            _ctx.resume().then(_onContextRunning).catch(() => {});
        }
    }

    function audioBgSuspend() {
        // Called when app goes to background. Fades music first to avoid click on hard suspend.
        if (!_ctx || _ctx.state !== 'running') return;
        _musicGain.gain.cancelScheduledValues(_ctx.currentTime);
        _musicGain.gain.setTargetAtTime(0, _ctx.currentTime, 0.02);
        _bgSuspended = true;
        setTimeout(() => { try { if (_ctx && _ctx.state === 'running') _ctx.suspend(); } catch(e) {} }, 120);
    }

    // ── Music ─────────────────────────────────────────────────────

    function musicPlay(trackId) {
        // Start a music track. No-op if already playing this track.
        if (!_ctx || _currentTrack === trackId) return;
        _currentTrack = trackId; _musicIsPaused = false;
        _channelState = SEQ[trackId].channels.map(() => ({ pos: 0, nextNote: _ctx.currentTime }));
        // Set gain unconditionally: on a suspended AC, setValueAtTime at the frozen
        // currentTime applies immediately when AC resumes and time advances past it.
        _musicGain.gain.cancelScheduledValues(_ctx.currentTime);
        _musicGain.gain.setValueAtTime(0.32 * _musicVol, _ctx.currentTime);
    }

    function musicStop() {
        _currentTrack = null; _musicIsPaused = false;
        if (_ctx && _musicGain) {
            _musicGain.gain.cancelScheduledValues(_ctx.currentTime);
            _musicGain.gain.setTargetAtTime(0, _ctx.currentTime, 0.04);
        }
    }

    function musicGamePause() {
        if (!_ctx || !_currentTrack) return;
        _musicIsPaused = true;
        _musicGain.gain.cancelScheduledValues(_ctx.currentTime);
        _musicGain.gain.setTargetAtTime(0, _ctx.currentTime, 0.04);
    }

    function musicGameUnpause() {
        if (!_ctx || !_currentTrack) return;
        _musicIsPaused = false;
        const now = _ctx.currentTime;
        _channelState.forEach(s => { s.nextNote = now + 0.05; });
        _musicGain.gain.cancelScheduledValues(now);
        _musicGain.gain.setValueAtTime(0.32 * _musicVol, now);
    }

    function musicSetVolume(vol) {
        _musicVol = vol;
        if (_musicGain && _currentTrack && !_musicIsPaused && _ctx && _ctx.state === 'running') {
            _musicGain.gain.cancelScheduledValues(_ctx.currentTime);
            _musicGain.gain.setValueAtTime(0.32 * vol, _ctx.currentTime);
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

    // ── SFX ───────────────────────────────────────────────────────

    function sfxPlay(type, on = true) {
        // on: pass cfg.music to gate playback on the sound-enabled setting.
        // Omit (or pass true) to play unconditionally (e.g. iOS audio pipeline priming).
        if (!_ctx || !on) return;
        const now = _ctx.currentTime;
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
            t(1568, now, 0.03); t(1319, now + 0.045, 0.04); t(880, now + 0.095, 0.08);
        }
    }

    function sfxSetVolume(vol) {
        _sfxVol = vol;
        if (_sfxGain) _sfxGain.gain.value = 0.58 * vol;
    }

    // ── App-level mute / unmute ───────────────────────────────────

    function musicMute() {
        musicStop();
    }

    function musicUnmute(sfxType = 'nav') {
        // sfxType: which sfx to play after resuming (helps unlock iOS audio pipeline).
        // Defaults to 'nav'; pass 'select' when unmuting from the settings screen.
        audioResume();
        sfxPlay(sfxType);
    }

    // Eager init: build the audio graph immediately so the first gesture only needs resume().
    // AC starts suspended on iOS; no audio plays until resume() is called from a gesture.
    audioInit();

    // Document-level capture listener: fires on the absolute first touch anywhere on the
    // page, before any game handler sees it. Gives iOS an early resume() attempt so that
    // by the time the user reaches INSERT COIN the context is likely already running.
    const _unlockOnce = () => {
        audioResume();
        document.removeEventListener('touchstart', _unlockOnce, true);
    };
    document.addEventListener('touchstart', _unlockOnce, true);

    return {
        audioInit, audioResume, audioTryResume, audioBgSuspend,
        musicPlay, musicStop, musicGamePause, musicGameUnpause, musicSetVolume, musicTick,
        sfxPlay, sfxSetVolume,
        musicMute, musicUnmute,
    };
})();
