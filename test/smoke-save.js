// Save/debug smoke: backup integrity checksum + the hidden DEBUGGING settings category.
// Run: node test/smoke-save.js
const { runTest } = require('./harness');

runTest('SMOKE-SAVE', `
;(function(){
  const R = globalThis.__R = { steps: [], err: null, ok: false };
  const log = (m) => R.steps.push(m);
  try {
    // Backup integrity checksum: non-zero for real data, and any edit changes it.
    const _snap={v:1,hs:'x',coins:'100',ach:'{}',cfg:'{}',name:'AB'};
    const _good=_sumOf(_snap);
    if(!(_good>0)) throw 'save checksum should be non-zero for real data';
    if(_sumOf({..._snap,coins:'999999'})===_good) throw 'editing data must change the checksum';
    log('save checksum ok');

    // Hidden DEBUGGING category: absent at debug=0, present + rendering at debug>0.
    cfg.debug=0; if(_cats().some(c=>c.label==='DEBUGGING')) throw 'DEBUGGING must be hidden at debug=0';
    cfg.debug=1; if(!_cats().some(c=>c.label==='DEBUGGING')) throw 'DEBUGGING must appear at debug>0';
    phase='settings'; settingsCat=_cats().length-1;
    for(settingsSel=0; settingsSel<=_cats()[settingsCat].items.length; settingsSel++) drawSettings();
    cfg.debug=0; settingsCat=-1; settingsSel=0;
    log('debug menu ok');

    // X10 RARE EVENTS: the item exists in the DEBUG menu and toggles + persists cfg.x10.
    const _x10item=DEBUG_CAT.items.find(i=>i.lbl().indexOf('X10 RARE EVENTS')===0);
    if(!_x10item) throw 'X10 RARE EVENTS missing from the DEBUG menu';
    const _x0=!!cfg.x10; _x10item.act();
    if(!!cfg.x10===_x0) throw 'X10 toggle did not flip cfg.x10';
    _x10item.act();
    if(!!cfg.x10!==_x0) throw 'X10 toggle did not flip back';
    if(!('x10' in defaultCfg())) throw 'cfg.x10 missing from defaultCfg (not persisted)';
    log('x10 debug switch ok');

    // Player ID: generated once, stable, well-formed, shown in SETTINGS > USER,
    // and carried inside backups (checksum stays valid for old backups without it).
    const id1=getPlayerId(), id2=getPlayerId();
    if(!/^[0-9a-f]{8}$/.test(id1)) throw 'player ID malformed: '+id1;
    if(id1!==id2) throw 'player ID not stable across reads';
    if(!/^[0-9A-F]{4}-[0-9A-F]{4}$/.test(fmtPlayerId())) throw 'player ID display format wrong: '+fmtPlayerId();
    if(friendUrl()!==GAME_URL+'#friend='+id1) throw 'friend URL malformed: '+friendUrl();
    const userCat=SETTINGS_CATS.find(c=>c.label==='USER');
    if(!userCat) throw 'USER settings category missing';
    if(!userCat.items.some(i=>i.lbl().indexOf('NAME: ')===0)) throw 'NAME entry missing from USER menu';
    if(_saveSnapshot().pid!==id1) throw 'backup snapshot does not carry the player ID';
    const _old={v:1,hs:'x',coins:'1',ach:'{}',cfg:'{}',name:'A'};   // pre-pid backup shape
    if(_sumOf(_old)!==_sumOf({..._old,pid:undefined,friends:undefined})) throw 'old backups without pid/friends must checksum identically';
    log('player ID ok: '+fmtPlayerId());

    // Friends list: validated, deduplicated, own-ID rejected, carried in backups.
    localStorage.removeItem('fok-snake-friends');
    if(getFriends().length!==0) throw 'friends must start empty';
    if(addFriend('nothexid')) throw 'malformed friend ID must be rejected';
    if(addFriend(getPlayerId())) throw 'own ID must be rejected as friend';
    if(!addFriend('00ff00aa')) throw 'valid friend ID rejected';
    if(!addFriend('00ff00aa')) throw 'repeated add must stay a success (idempotent)';
    if(getFriends().length!==1||getFriends()[0]!=='00ff00aa') throw 'friends list wrong: '+JSON.stringify(getFriends());
    if(_saveSnapshot().friends!==JSON.stringify(['00ff00aa'])) throw 'backup snapshot does not carry friends';
    if(fmtFriendId('00ff00aa')!=='00FF-00AA') throw 'friend ID display format wrong';
    log('friends list ok');

    // QR + decoder tests run on a PINNED ID so they are deterministic (the decoder
    // margin tests would otherwise depend on the run's random player ID).
    localStorage.setItem('fok-snake-pid','0123abcd');
    // QR self-verification: structure + Reed-Solomon (every syndrome must be zero --
    // a decoder-grade check of the ECC math) + payload survives in the codewords.
    const q=qrMatrix(friendUrl());
    if(q.size!==29) throw 'qr: wrong size '+q.size;
    if(!q.m[0][0]||!q.m[0][28]||!q.m[28][0]) throw 'qr: finder corners missing';
    if(q.m[0][7]||q.m[7][0]) throw 'qr: finder separators not light';
    for(let i=8;i<20;i++) if(q.m[6][i]!==(i%2===0)) throw 'qr: timing row broken at '+i;
    if(!q.m[21][8]) throw 'qr: dark module missing';
    const cw=_qrCodewords(friendUrl());
    if(cw.length!==70) throw 'qr: wrong codeword count '+cw.length;
    let alpha=1;
    for(let i=0;i<15;i++){
        let v=0;
        for(const c of cw) v=_gfMul(v,alpha)^c;
        if(v!==0) throw 'qr: RS syndrome '+i+' nonzero ('+v+')';
        alpha=_gfMul(alpha,2);
    }
    // Payload survives encoding: byte mode header is 4+8 bits, so the char count and
    // the first character straddle codewords 0-2 at a 4-bit offset.
    const url=friendUrl();
    const qlen=((cw[0]&0x0F)<<4)|(cw[1]>>>4);
    if(qlen!==url.length) throw 'qr: encoded length '+qlen+' != '+url.length;
    const qc0=((cw[1]&0x0F)<<4)|(cw[2]>>>4);
    if(qc0!==url.charCodeAt(0)) throw 'qr: first payload byte mismatch';
    log('qr ok: 29x29, RS syndromes clean, payload verified');

    // Decoder roundtrip: rasterize the matrix (with quiet zone + a 180deg rotation --
    // a phone held upside down) and the camera-path decoder must read it back exactly.
    if(_qrDataOrder().length!==567) throw 'qr: data-module count '+_qrDataOrder().length+' != 567 (V3 spec)';
    const _mod=6,_quiet=4,_S=(29+_quiet*2)*_mod;
    const _mk=(rot)=>{
        const im={width:_S,height:_S,data:new Uint8ClampedArray(_S*_S*4).fill(255)};
        for(let r=0;r<29;r++)for(let c=0;c<29;c++){
            const rr2=rot?28-r:r, cc2=rot?28-c:c;
            if(!q.m[rr2][cc2]) continue;
            for(let dy=0;dy<_mod;dy++)for(let dx=0;dx<_mod;dx++){
                const p=(((_quiet+r)*_mod+dy)*_S+(_quiet+c)*_mod+dx)*4;
                im.data[p]=im.data[p+1]=im.data[p+2]=0;
            }
        }
        return im;
    };
    if(qrDecodeImage(_mk(false))!==friendUrl()) throw 'qr decoder failed on a clean image';
    if(qrDecodeImage(_mk(true))!==friendUrl()) throw 'qr decoder failed on a rotated image';
    if(qrDecodeImage({width:64,height:64,data:new Uint8ClampedArray(64*64*4).fill(255)})!==null) throw 'qr decoder must return null on a blank image';
    log('qr decoder roundtrip ok (incl. 180deg rotation)');

    // RS error correction: up to 7 corrupted codewords repair exactly; 8 must reject.
    const _cwGood=_qrCodewords(friendUrl());
    for(const nerr of [1,4,7]){
        const cwBad=_cwGood.slice();
        for(let i=0;i<nerr;i++) cwBad[i*9+2]^=(0x5A+i);   // spread, deterministic corruption
        const fixed=_rsCorrect(cwBad);
        if(!fixed||fixed.join(',')!==_cwGood.join(',')) throw 'RS correction failed at '+nerr+' errors';
    }
    { const cwBad=_cwGood.slice();
      for(let i=0;i<8;i++) cwBad[i*8+1]^=(0x33+i);
      if(_rsCorrect(cwBad)!==null) throw 'RS must reject 8 errors (capacity is 7)'; }
    log('rs correction ok (7 fix, 8 reject)');

    // Camera-realism roundtrip: perspective-warped grid + uneven illumination.
    // (This exercises the adaptive threshold, the alignment-pattern lock and the
    // homography -- the exact failure modes of a handheld phone scan.)
    const _PW=360;
    const _pimg={width:_PW,height:_PW,data:new Uint8ClampedArray(_PW*_PW*4)};
    for(let y=0;y<_PW;y++)for(let x=0;x<_PW;x++){
        // Inverse projective map from pixels to module space (mild keystone + shear).
        const w=1+0.00035*x+0.0002*y;
        const u=((x-40)/9.0+0.06*((y-40)/9.0))/w;
        const v=((y-40)/9.0)/w;
        const c=Math.floor(u), r=Math.floor(v);
        const isDark=c>=0&&c<29&&r>=0&&r<29&&q.m[r][c];
        const shade=isDark?(30+40*y/_PW):(170+70*x/_PW);   // uneven lighting both ways
        const p=(y*_PW+x)*4;
        _pimg.data[p]=_pimg.data[p+1]=_pimg.data[p+2]=shade; _pimg.data[p+3]=255;
    }
    if(qrDecodeImage(_pimg)!==friendUrl()) throw 'qr decoder failed on the perspective-warped image';
    log('qr decoder camera-realism ok (perspective + uneven light)');

    R.ok = true;
  } catch(e) { R.err = String(e && e.stack || e); }
})();
`);
