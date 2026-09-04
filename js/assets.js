// ================================================================
// STATIC GAME DATA
// ================================================================
// AUTO-MANAGED by the pre-commit hook (mirrors sw.js CACHE). This is the version of the
// CODE actually running -- read it, not the service-worker cache name, which lags behind
// until the new worker installs and claims.
const APP_VERSION = 'v3.2.3';
const GAME_URL = 'https://poeggi.github.io/FOK-snake/';   // canonical deploy (friend links, QR)
const COLS = 30, ROWS = 20, CS = 20;
const CW = COLS * CS, CH = ROWS * CS;
const HINT_Y = CH - 14;   // shared bottom Y for every keyboard-hint line (ct(), baseline middle)
const GEMS_PER_LEVEL = 10, MAX_LEVELS = 10, START_LIVES = 3;
// Fixed-timestep simulation clock. The whole game advances in integer sim-ticks;
// everything time-based is expressed in ticks, not wall-clock milliseconds, so the
// simulation is deterministic and can later be driven by a server/peer clock.
const SIM_HZ = 60, TICK_MS = 1000 / SIM_HZ;   // 60 Hz base tick (16.67 ms per tick)
const T = t => t * TICK_MS;                    // ticks -> sim-clock ms
const MAX_CATCHUP = 5;                          // max sim ticks simulated per rendered frame
// Cosmetic sim events -- sounds, particle bursts, floating labels, the windswept steal --
// never fire when the sim emits them. They queue for a fixed 2-engine-tick (1/30s) delay so
// an online correction arriving inside that window can cancel a wrongly predicted effect
// before it is seen, heard, or written to the wardrobe. Both homes filter on THIS one set:
// game.js queues and dispatches them, sim-worker.js re-queues exactly these during a
// rollback re-sim. It lives here, shared, because a kind listed in one home and forgotten in
// another is not a visible bug -- the effect is simply dropped and never fires again.
const FX_DEFER = new Set(['sfx', 'bonus', 'bite', 'crash', 'crush', 'fw', 'nearmiss', 'wsblow', 'wsget']);
const HEART_PX = [[0,1,1,0,1,1,0],[1,1,1,1,1,1,1],[1,1,1,1,1,1,1],[0,1,1,1,1,1,0],[0,0,1,1,1,0,0],[0,0,0,1,0,0,0]];
// Speaker split into two 8x8 icons drawn side by side (total 32x16px at CS=2)
// BODY: cone only (cols 0-3). WAVES: 3 arcs inner(col1,rows3-4) mid(col3,rows2-5) outer(col5,rows1-6). X: diagonal cross for muted.
const SPEAKER_BODY  = [[0,0,0,1,0,0,0,0],[0,0,1,1,0,0,0,0],[1,1,1,1,0,0,0,0],[1,1,1,1,0,0,0,0],[1,1,1,1,0,0,0,0],[1,1,1,1,0,0,0,0],[0,0,1,1,0,0,0,0],[0,0,0,1,0,0,0,0]];
const SPEAKER_WAVES = [[0,0,0,0,0,0,0,0],[0,0,0,0,0,1,0,0],[0,0,0,1,0,1,0,0],[0,1,0,1,0,1,0,0],[0,1,0,1,0,1,0,0],[0,0,0,1,0,1,0,0],[0,0,0,0,0,1,0,0],[0,0,0,0,0,0,0,0]];
const SPEAKER_X     = [[0,0,0,0,0,0,0,0],[0,1,0,0,0,1,0,0],[0,0,1,0,1,0,0,0],[0,0,0,1,0,0,0,0],[0,0,0,1,0,0,0,0],[0,0,1,0,1,0,0,0],[0,1,0,0,0,1,0,0],[0,0,0,0,0,0,0,0]];
// Pixel art standard: CS=2 (1 artwork pixel = 2x2 screen pixels)
// Icons (achievements, shop, speaker): 8x8 artwork -> 16x16px on screen
// Coin: 16x16 artwork -> 32x32px on screen
// Coin symbol pixel grids -- [col, row] pairs, drawn at cs=2, centered in coin face
// "1": 4x6 simple (angled top, no base)  (screen: 8x12px)
const SYM_ONE = { w:4, h:6, px:[[2,0],[1,1],[2,1],[2,2],[2,3],[2,4],[2,5]] };
// yen sign: 5x7  (screen: 10x14px)
const SYM_YEN = { w:5, h:7, px:[[0,0],[4,0],[1,1],[3,1],[2,2],[0,3],[1,3],[2,3],[3,3],[4,3],[2,4],[0,5],[1,5],[2,5],[3,5],[4,5],[2,6]] };
const DEATH_DUR = T(84), LEVELDONE_DUR = T(84), READY_DUR = T(60), GO_DUR = T(18);
// Main-menu announcement. Set to null when there is nothing to announce.
// The paper is always titled NEW SNAKE TIMES; supply a fresh id (drives the
// unread badge) and one or more pages, each a headline + body lines ('' = blank
// gap line). Pages are flipped with LEFT/RIGHT; the newest goes first.
const ANNOUNCEMENT = { id:'v3.1.0', pages:[
    { headline:'TOURNAMENT NIGHT', lines:[
        'NEW IN v3.1:',
        'Up to 8 players, one trophy',
        'Everyone on your network sees',
        'your tournament - or they join',
        'with the 6-letter code',
        '',
        'Two play, the rest all watch.',
        'Last one standing takes it.' ] },
    { headline:'PULL UP A CHAIR', lines:[
        'NEW IN v3.1:',
        'WATCH a friend who is already',
        'in a duel - straight from the',
        '1:1 lobby, a moment behind live',
        '',
        'Not a replay. The same game,',
        'the same snakes, as it happens.' ] },
    { headline:'CRASH, BANG, WALLOP', lines:[
        'NEW IN v2.7:',
        'Prettier all round - gear knocked',
        'off a snake now tumbles high and',
        'lands in a puff of dust',
        '',
        'Ram a wall and it dents, you see',
        'stars, and at full boost the tail',
        'folds up like a train wreck.' ] },
    { headline:'FINDERS KEEPERS', lines:[
        'NEW IN v2.7:',
        'WINDSWEPT gear gets knocked off',
        'when two snakes graze in 1:1',
        'It lands nearby - grab it first',
        'and it is yours to keep',
        '',
        'Cheap trinkets fly off easily.',
        'Crowns cling on.' ] },
    { headline:'DUELS, REFORGED', lines:[
        'NEW IN v2.6:',
        'Online games are snappier -',
        'less lag, optimized latency',
        'Rock-solid starts, levels,',
        'respawns and rematches',
        '',
        'Dropped connection? The match',
        'RESUMES instead of ending.' ] },
    { headline:'THE STORY SO FAR', lines:[
        'SINCE v2.0:',
        '1:1 ONLINE - friends by ID or QR',
        'or a quick match with a stranger',
        'SPEED ROUNDS at level 10 pace',
        'Power pellet? Eat your rival!',
        'Duel HEART steals a life back',
        'Global high scores, gold stars,',
        'HARD mode and a live menu snake.' ] },
] };
// Minecraft-style title splash lines; one is picked at random each load.
// Keep them short and ASCII so they fit the tilted, pulsing draw.
const SPLASHES = [
    '100% pure!', 'Gouranga!', 'Also try Tetris!', 'Eat the gems!',
    'Mind the walls!', 'Nokia would be proud!', 'Hare Krishna!', 'sssssss!',
    'FOKoins to the moon!', 'Do a barrel roll!', 'Made in Hamburg!',
    'Multiplayer soon!', 'Time is a crystal!', 'Wear the gown!', 'Turbo!',
    'git gud!', 'Snek!', 'The tail remembers.', 'Collect them all!',
    'Achievement get!', 'Press START!', 'Perfectly balanced!', 'One more run!',
    'Beep boop!', 'Powered by FOKoins!', 'Try the wizard hat!',
    'Watch the barricades!', 'You are the snake.', 'No walls were harmed.',
    'Now with two shop pages!',
];
const MAX_NAME = 15;
const NAME_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-!?.,\'"#$@&()[]:+ \r';
const HEX_CHARS = '0123456789ABCDEF\r';   // ADD FRIEND entry dial (player IDs are hex)
// JOIN TOURNAMENT entry dial. The server mints join codes from an alphabet with no 0/O,
// 1/I/L in it, so nothing anyone reads out of a chat window or across a room is
// ambiguous -- and the dial offers exactly the characters a code can contain.
const CODE_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ\r';
const CODE_LEN = 6;

// Per-level GAME TICK: engine ticks (1/60 s) per game tick = the level's fixed
// boost period G (>=2, so <=30 Hz). Normal movement advances one cell every 2
// game ticks (period 2G); boost advances every game tick (period G, exactly 2x).
// Boost is a parity toggle, never a re-divisor, so the game tick is fixed per
// level -- the invariant the network cadence (max(4,G) engine ticks) syncs to.
// bars = barricade count.
const LEVEL_CFG = [
    { easy:7, normal:6, hard:5, bars:0  },
    { easy:7, normal:6, hard:5, bars:2  },
    { easy:7, normal:6, hard:5, bars:4  },
    { easy:6, normal:5, hard:4, bars:6  },
    { easy:6, normal:5, hard:4, bars:8  },
    { easy:6, normal:5, hard:4, bars:10 },
    { easy:5, normal:4, hard:3, bars:12 },
    { easy:5, normal:4, hard:3, bars:14 },
    { easy:4, normal:3, hard:2, bars:16 },
    { easy:4, normal:3, hard:2, bars:18 },
];

const DIFF = [
    { bm: 0.4,  label: 'EASY'   },
    { bm: 1.0,  label: 'NORMAL' },
    { bm: 1.6,  label: 'HARD'   },
];

const SNAKE_COLORS = [
    { h: 120, head: '#7fff7f', name: 'GREEN'  },
    { h: 55,  head: '#ffff44', name: 'YELLOW' },
    { h: 200, head: '#44aaff', name: 'BLUE'   },
    { h: 285, head: '#cc66ff', name: 'PURPLE' },
    { h: 0,   head: '#ff7777', name: 'RED'    },
    { h: 30,  head: '#ffaa44', name: 'ORANGE' },
];

const ACHIEVEMENTS = [
    { id:'first_gem',     name:'FIRST BITE',    desc:'Collect your first gem',
      icon:{p:{A:'#44ccff',B:'#00ffff',C:'#aaffff'},d:['...A....','..ABA...','.ABCBA..','ABCCCBA.','.ABCBA..','..ABA...','...A....','........']}},
    { id:'level1',        name:'RISING SNAKE',  desc:'Complete level 2',
      icon:{p:{A:'#7fff7f',B:'#001500'},d:['.AAAAAA.','AAAAAAAA','AAAAAAAA','ABAAAAAB','AAAAAAAA','AAAAAAAA','.AAAAAA.','........']}},
    { id:'fokoins_1k',    name:'POCKET CHANGE', desc:'Earn 25,000 FOKoins',
      icon:{p:{A:'#ffd700',B:'#cc8800'},d:['...BB...','..AAAA..', '.ABBBBA.','.ABBBBA.','AABBBBA.','.ABBBBA.','..AAAA..','........']}},
    { id:'lucky_gem',     name:'LUCKY CATCH',   desc:'Collect a lucky gem',
      icon:{p:{A:'#ffd700',B:'#ffee88',C:'#cc8800'},d:['...A....','..ABA...','.ABCBA..','ABCCCBA.','.ABCBA..','..ABA...','...A....','........']}},
    { id:'bonus_3',       name:'SPEEDSTER',     desc:'5 x2 bonuses in one level',
      icon:{p:{A:'#ffff44',B:'#aaaa00'},d:['....AAA.','...AA...','..AA....','BAAAAAAB','....AA..','...AA...','..AAA...','........']}},
    { id:'level5',        name:'HALFWAY HERO',  desc:'Reach level 5',
      icon:{p:{A:'#7fff7f'},d:['.AAAAAAA','.A......','.A......','.AAAAAAA','.......A','.......A','.AAAAAAA','........']}},
    { id:'fokoins_10k',   name:'COIN HOARDER',  desc:'Earn 100,000 FOKoins',
      icon:{p:{A:'#ffd700',B:'#cc8800',C:'#ffee44'},d:['..AAAA..', '.ACCCCA.','.ACCCCA.','AACCCCA.','AACCCCA.','.ACCCCA.','..AAAA..','........']}},
    { id:'epic_gem',      name:'EPIC HUNTER',   desc:'Collect an epic gem',
      icon:{p:{A:'#cc44ff',B:'#ff88ff',C:'#ffffff'},d:['...A....','..ABA...','.ABCBA..','ABCCCBA.','.ABCBA..','..ABA...','...A....','........']}},
    { id:'gouranga',      name:'GOURANGA!',     desc:'7 in a row. Hare Krishna.',
      icon:{p:{A:'#ff8800',B:'#ffcc44'},d:['........','........','........','ABABABA.','ABABABA.','........','........','........']}},
    { id:'level10',       name:'CHAMPION',      desc:'All 10 levels on normal+',
      icon:{p:{A:'#ffd700',B:'#cc8800'},d:['.AAAAA..','AAAAAAA.','AAAAAAA.','AAAAAAA.','.AAAAA..','..AAA...','BBBBBBB.','........']}},
    { id:'fokoins_1m',    name:'MILLIONAIRE',   desc:'Earn 1,000,000 total FOKoins',
      icon:{p:{A:'#00ddff'},d:['...A....','..AAA...','.AAAAA..','AAAAAAA.','.AAAAA..','..AAA...','...A....','........']}},
    { id:'score_25k',     name:'HIGH ROLLER',   desc:'Score 100,000 in one game',
      icon:{p:{A:'#ff4400',B:'#ff9900',C:'#ffdd00'},d:['...A....','..ABA...','.ABBBA..','ABBBBA..','ABCBBBA.','ABCCCBA.','.AAAAAA.','........']}},
];

const EXPERT_ACHIEVEMENTS = [
    { id:'score_100k',  name:'SCORE HUNTER',  desc:'Score 200,000 in one game',
      icon:{p:{A:'#ff8800',B:'#cc5500'},
      d:['A.AA.AA.','AAAAAAAA','ABBBBBBA','ABBBBBBA','ABBBBBBA','AAAAAAAA','.AAAAAA.','........']}},
    { id:'perfect_level', name:'PERFECTIONIST', desc:'Complete a level perfectly',
      icon:{p:{A:'#ffd700',B:'#cc8800'},
      d:['A..A..A.','AAAAAAA.','AAAAAAA.','AAAAAAA.','BAAAAAAB','BAAAAAAB','........','........']}},
    { id:'hard_champ',  name:'IRON SNAKE',    desc:'Beat all 10 levels on hard',
      icon:{p:{A:'#cccccc',B:'#888888'},
      d:['.AAAAAA.','AAAAAAAA','ABBBBBBA','ABBBBBBA','.AAAAAA.','..AAAA..','...AA...','........']}},
    { id:'triple_perf', name:'TRIPLE ACE',    desc:'3 perfect levels in a run',
      icon:{p:{A:'#ffd700'},
      d:['......AA','....AAAA','..AAAAAA','AAAAAAAA','........','........','........','........']}},
    { id:'no_deaths',   name:'UNTOUCHABLE',   desc:'Beat level 10 with max lives',
      icon:{p:{A:'#00ff88'},
      d:['.AA.AA..','AAAAAAA.','.AAAAA..','.AAAAA..','..AAA...','...A....','........','........']}},
    { id:'shop_full',   name:'BIG SPENDER',   desc:'Own all shop items',
      icon:{p:{A:'#cc8800',B:'#996600',C:'#ffcc44'},
      d:['..CCCC..','..C..C..','CCCCCCCC','CBBBBBBC','CBBBBBBC','CBBBBBBC','CCCCCCCC','........']}},
    { id:'lucky_streak',name:'LUCKY STREAK',  desc:'3 lucky gems in one game',
      icon:{p:{A:'#00cc44'},
      d:['.AA.AA..','AAAAAAA.','AAAAAAA.','..AAAA..','..AAAA..','...AA...','...AA...','........']}},
    { id:'epic_double', name:'EPIC DOUBLE',   desc:'2 epic gems in one level',
      icon:{p:{A:'#cc44ff',B:'#9900cc'},
      d:['.A..A...','AAA.AAA.','.A..A...','........','........','........','........','........']}},
    { id:'fokoins_100k', name:'DRAGON RICH',  desc:'Earn 100M total FOKoins',
      icon:{p:{A:'#888888',B:'#333333',C:'#cccccc',D:'#eeeeee'},
      d:['AAAAAAAA','ACDDDDCA','ADDDDDDA','ADDBDDDA','ADDDDDDA','ACDDDDCA','AAAAAAAA','........']}},
];

// The blank an unbuilt egg wears: a grey question mark, shared so the reserved slots
// cannot drift apart from each other.
const EGG_BLANK_ICON = {p:{A:'#666666'},
    d:['..AAAA..','.AA..AA.','.....AA.','....AA..','...AA...','........','...AA...','........']};
// The hidden page: each of these is an easter egg, and the page itself is one too --
// it only becomes swipeable once a first egg is found, and swiping to it unlocks the
// last. Never listed on the visible pages, so a fresh install cannot know they exist.
const EGG_ACHIEVEMENTS = [
    { id:'egg_ringtone', name:'RING RING',   desc:'Take the snake theme home',
      icon:{p:{A:'#ffd700',B:'#cc8800'},
      d:['...A....','..AAA...','..AAA...','.AAAAA..','.AAAAA..','AAAAAAA.','...B....','........']}},
    { id:'egg_credits',  name:'TRUE ENDING', desc:'No easter eggs in the credits',
      icon:{p:{A:'#ff5555',B:'#ffffff'},
      d:['........','..BBBB..','.B....B.','B..AA..B','B..AA..B','.B....B.','..BBBB..','........']}},
    { id:'egg_page',     name:'OFF THE MAP', desc:'Swipe past the last page',
      icon:{p:{A:'#ff4488',B:'#aa2255'},
      d:['..AAAA..','.AA..AA.','.....AA.','....AA..','...AA...','........','...AA...','........']}},
    // Reserved slots: the page is meant to read as incomplete, so the eggs still to be
    // built are already on it as blanks. Name and desc get filled in when each one lands.
    { id:'egg_tbd1',     name:'???',         desc:'???', icon:EGG_BLANK_ICON },
    { id:'egg_tbd2',     name:'???',         desc:'???', icon:EGG_BLANK_ICON },
    { id:'egg_tbd3',     name:'???',         desc:'???', icon:EGG_BLANK_ICON },
];

// Wearing metadata on cosmetics (shop + box items alike):
//   cat      : wear slot, never shown in the UI. Only ONE item per slot can be worn at a
//              time ('head' = headwear, 'eyes' = eyewear, 'neck' = neckwear, 'masquerade' =
//              face disguise, 'divine' = halo and the like); _shopToggleWear refuses a
//              second item of an occupied slot.
//   windswept: loose enough to be knocked off in a 1:1 duel -- a near-miss can blow it
//              away for the rival to pick up (see WINDSWEPT_ITEMS). Shown as a tag on the
//              shop rows; the cheaper the item, the likelier it comes off.
const SHOP_ITEMS = [
    { id:'necktie',  name:'NECKTIE',       desc:'Business on the grid',           price:25000, cat:'neck',
      icon:{p:{A:'#2a52be',B:'#1a3a8e',C:'#5a82ee'},d:['...BB...','...BB...','...AA...','..AAAA..','..ACCA..','..AAAA..','...AA...','........']}},
    { id:'shades',   name:'SUNGLASSES',    desc:'Too cool for the grid',          price:50000, cat:'eyes', windswept:true,
      icon:{p:{A:'#111111',B:'#1a3050'},d:['.AAA.AAA','ABBBABBB','ABBBABBB','.AAA.AAA','........','........','........','........']}},
    { id:'cylinder', name:'CYLINDER HAT',  desc:'A distinguished top hat',       price:100000, cat:'head', windswept:true,
      icon:{p:{A:'#1a1a1a',B:'#333333'},d:['........','..AAAA..','..AAAA..','..AAAA..','.BBBBBB.','........','........','........']}},
    { id:'donate',   name:'DONATE',        desc:'Support the dev. Repeatable!',  price:100000, repeatable:true,
      icon:{p:{A:'#ff4499',B:'#ff88cc'},d:['.AA.AA..','AAAAAAA.','AAAAAAA.','.AAAAA..','..AAA...','...A....','........','........']}},
    { id:'monocle',  name:'MONOCLE',       desc:'For the refined serpent',        price:150000, cat:'eyes', windswept:true,
      icon:{p:{H:'#d8d8d8',A:'#999999',S:'#484848',G:'#eeeeee',C:'#aaaaaa',D:'#555555'},d:['..HHAA..','.H....A.','.H.G..A.','.A....S.','..AASS..','.....CD.','....CD..','...CD...']}},
    { id:'bow',      name:'BOW TIE',       desc:'Charming and aerodynamic',       price:250000, cat:'neck',
      icon:{p:{A:'#cc2222',B:'#ff4444',C:'#aa0000'},d:['........','AA...AA.','ABBACBBA','AABACBAA','AA...AA.','........','........','........']}},
    // --- Page 2 ---
    { id:'shoes',    name:'SHOES',         desc:'Fresh kicks for the tail',       price:300000, page:1,
      icon:{p:{W:'#eeeeee',S:'#cc2222',L:'#333333'},d:['........','........','........','WW...WW.','WWW.WWW.','SSS.SSS.','LLL.LLL.','........']}},
    { id:'moustache',name:'MOUSTACHE',     desc:'A dashing handlebar',            price:450000, page:1, cat:'masquerade', windswept:true,
      icon:{p:{A:'#3a2a1a'},d:['........','........','........','.A....A.','AAA..AAA','.AAAAAA.','..AAAA..','........']}},
    { id:'halo',     name:'HALO',          desc:'For the angelic serpent',        price:650000, page:1, cat:'divine',
      icon:{p:{A:'#ffd83a',G:'#fff4a0'},d:['........','.GAAAAG.','A......A','A......A','.GAAAAG.','........','........','........']}},
    { id:'wizard',   name:'WIZARD HAT',    desc:'Arcane and pointy',              price:900000, page:1, cat:'head', windswept:true,
      icon:{p:{P:'#5a2a9a',S:'#ffe860',B:'#3a1a6a'},d:['...S....','...P....','..PPP...','..PPP...','.PPPPP..','PPPPPPP.','BBBBBBB.','........']}},
    { id:'crown',    name:'ROYAL CROWN',   desc:'Fit for a snake king',           price:1000000, page:1, cat:'head', windswept:true,
      icon:{p:{A:'#ffd700',C:'#ff4444'},d:['A..A..A.','AAAAAAA.','ACAAACA.','AAAAAAA.','........','........','........','........']}},
    { id:'gown',     name:'INVISIBLE GOWN',desc:'Unseen - shimmers when you soar',price:3000000, page:1,
      icon:{p:{A:'#8fbfe0',S:'#ffffff'},d:['...S....','..AAA...','..A.A...','.A...A..','.A...A..','.AAAAA..','.AAAAA..','S......S']}},
];

// ---------------- Mystery boxes ----------------
// Every existing cosmetic (except the repeatable 'donate') gets a loot rarity. A few
// box-exclusive cosmetics (art added in a later stage) round out the pool; the ADMIN
// item is exclusive to the ADMIN box. All loot is cosmetic -- no gameplay advantage.
const ITEM_RARITY = {
    necktie:'common', shades:'common', cylinder:'common',
    monocle:'rare',   bow:'rare',      shoes:'rare',
    moustache:'epic', halo:'epic',     wizard:'epic',
    crown:'legendary', gown:'legendary',
};
const BOX_ITEMS = [
    { id:'eyepatch',   name:'EYEPATCH',      rarity:'common',    value:80000,   cat:'eyes', windswept:true, desc:'Arr. Box-only.',
      icon:{p:{A:'#0a0a0a',S:'#3a3a3a'},d:['........','S.....S.','.S...S..','..AAA...','..AAA...','..AAA...','........','........']}},
    { id:'glasses3d',  name:'3D GLASSES',    rarity:'rare',      value:220000,  cat:'eyes', windswept:true, desc:'Everything pops. Box-only.',
      icon:{p:{R:'#ff2a2a',C:'#22e0ff',F:'#111111'},d:['........','.FFFFFF.','.FRRCCF.','.FRRCCF.','.FFFFFF.','........','........','........']}},
    { id:'propeller',  name:'PROPELLER HAT', rarity:'epic',      value:600000,  cat:'head', windswept:true, desc:'Ready for takeoff. Box-only.',
      icon:{p:{R:'#e03c3c',Y:'#f5d020',G:'#2aa84a',B:'#4a90d9',H:'#ffd700',S:'#888888'},d:['..B..R..','..BBRR..','...HH...','...S....','..RRRR..','.YRYRYR.','.GGGGGG.','........']}},
    { id:'blackbelt',  name:'BLACK BELT',    rarity:'rare',      value:250000,  desc:'Dojo master. Box-only.',
      icon:{p:{B:'#111111',D:'#3a3a3a'},d:['........','........','BBBBBBBB','BDDDDDDB','...BB...','..B..B..','..B..B..','........']}},
    { id:'lasereyes',  name:'LASER EYES',    rarity:'epic',      value:650000,  desc:'Pew pew. Box-only.',
      icon:{p:{R:'#ff2a2a',H:'#ff9090'},d:['........','........','HH....HH','RRRRRRRR','HH....HH','........','........','........']}},
    { id:'goldchain',  name:'GOLD CHAIN',    rarity:'legendary', value:1500000, desc:'Ice cold bling. Box-only.',
      icon:{p:{G:'#ffd700',Y:'#b8860b',M:'#fff2a0'},d:['........','........','G......G','.G....G.','..G..G..','..GYYG..','...MM...','........']}},
    { id:'admincrown', name:'ADMIN CROWN',   rarity:'legendary', value:5000000, admin:true, cat:'head', windswept:true, desc:'ADMIN box only. The trophy.',
      icon:{p:{A:'#ffe860',C:'#00e5ff',B:'#cc9a00'},d:['C..C..C.','AAAAAAA.','ACAAACA.','AAAAAAA.','BBBBBBB.','........','........','........']}},
];
// ---------------- Windswept cosmetics (1:1 steal) ----------------
// Every windswept cosmetic in ONE fixed order: shop items first, then box items, exactly as
// the two tables above are written. The ORDER IS A LOCKSTEP CONTRACT -- both clients build a
// player's worn-windswept list by walking THIS table (_wsWorn), never by walking a config
// object, whose key order is whatever that device happened to buy things in.
// pct = chance in percent that a single near-miss blows the item off, scaled by price: the
// cheap trinkets come off easily, the trophies cling on. An integer ladder, not a curve --
// the sim rolls this and sim-purity forbids Math.log there (see test/sim-purity.js).
function _wsPct(cost){
    if(cost <=   80000) return 40;
    if(cost <=  100000) return 35;
    if(cost <=  150000) return 30;
    if(cost <=  250000) return 25;
    if(cost <=  500000) return 20;
    if(cost <=  750000) return 15;
    if(cost <= 1000000) return 10;
    return 5;
}
const WINDSWEPT_ITEMS = SHOP_ITEMS.concat(BOX_ITEMS)
    .filter(o => o.windswept)
    .map(o => ({ id:o.id, name:o.name, cat:o.cat || '', icon:o.icon,
                 pct:_wsPct(o.price != null ? o.price : o.value) }));
// id -> that entry. The sim reads .pct (the roll) and .cat (a won item displaces whatever
// shares its slot); the renderer reads .icon and .name. Also the "is this id windswept?" test.
const WS = {};
for(const v of WINDSWEPT_ITEMS) WS[v.id] = v;
// The windswept items a player is WEARING, in table order. `worn` is a cfg.wornItems-shaped
// map (mine) or a peer profile's shopItems (theirs) -- both carry worn ids as keys.
function _wsWorn(worn){
    const w = worn || {}, out = [];
    for(const v of WINDSWEPT_ITEMS) if(w[v.id]) out.push(v.id);
    return out;
}
// Box tiers. odds = probability of each outcome (coins filler + a loot rarity); they
// bias toward rarer loot as the tier rises. Prices sit ABOVE expected loot value
// (house edge) -- enforced by test/box-odds.js. ADMIN box is a rare free-claim.
const BOXES = [
    { id:'common',    name:'COMMON',    color:'#9aa0a6', price:60000,
      odds:{ coins:0.72, common:0.22, rare:0.05,  epic:0.009, legendary:0.001 } },
    { id:'rare',      name:'RARE',      color:'#4a90d9', price:200000,
      odds:{ coins:0.55, common:0.18, rare:0.20,  epic:0.06,  legendary:0.01 } },
    { id:'epic',      name:'EPIC',      color:'#9b59b6', price:500000,
      odds:{ coins:0.34, common:0.10, rare:0.28,  epic:0.22,  legendary:0.06 } },
    { id:'legendary', name:'LEGENDARY', color:'#f1c40f', price:1000000,
      odds:{ coins:0.20, common:0.05, rare:0.20,  epic:0.35,  legendary:0.20 } },
];
const BOX_PITY = 8;          // consecutive junk pulls (coins/common) then a guaranteed upgrade
const ADMIN_BOX_EVERY = 750; // ADMIN box appears once every N shop opens
// The GRAND FINALE: a free box that surfaces once every ADMIN_BOX_EVERY shop opens and
// hands out the ADMIN CROWN -- the one cosmetic you cannot buy or win any other way.
const ADMIN_BOX = { id:'admin', name:'ADMIN', color:'#ff4455', price:0 };

// ================================================================
// PRESENTATION DATA  (palettes, particle tables, credits text)
// ================================================================
const CONFETTI_COLS = ['#ff4444','#ff9900','#ffff44','#44ff88','#44ccff','#aa44ff','#ff44cc','#ffffff'];
const RARITY_COLS = { common:'#9aa0a6', rare:'#4a90d9', epic:'#9b59b6', legendary:'#f1c40f' };
const FIREWORK_COLS = ['#ff4040','#ff9000','#ffee00','#40ff80','#00ccff','#cc44ff','#ff44aa','#ffffff'];
// Splash coin sparks: [dx, dy, speed, fade] per spark; speed >= 90 renders bright.
const SPARK_DEFS = [
    [-0.55,-1,72,1],    [0,-1,80,1],       [0.55,-1,72,1],
    [-1.1,-0.85,58,1],  [1.1,-0.85,58,1],
    [-0.25,-1,95,1],    [0.25,-1,95,1],
    [-1.4,-0.45,44,1],  [1.4,-0.45,44,1],
    [-0.8,-0.65,65,1],  [0.8,-0.65,65,1],
    [0,-0.75,108,1],
    [-0.4,-0.9,118,0.7],[0.4,-0.9,118,0.7],
    [-1.6,-0.2,38,0.8], [1.6,-0.2,38,0.8],
    [-0.15,-1,135,0.5], [0.15,-1,135,0.5],
    [-1.0,-1.0,50,0.9], [1.0,-1.0,50,0.9],
    [-0.7,-0.3,30,0.7], [0.7,-0.3,30,0.7],
    [-0.75,-0.75,62,1], [0.75,-0.75,62,1],
    [-1.2,-0.5,48,0.9], [1.2,-0.5,48,0.9],
    [-0.35,-0.95,85,1], [0.35,-0.95,85,1],
    [-1.8,0.1,33,0.8],  [1.8,0.1,33,0.8],
    [-1.3,-0.15,40,0.8],[1.3,-0.15,40,0.8],
    [-0.6,-0.5,55,0.9], [0.6,-0.5,55,0.9],
    [-0.1,-1,148,0.4],  [0.1,-1,148,0.4],
    [0,-1,125,0.6],
    [-0.5,-0.85,102,0.7],[0.5,-0.85,102,0.7],
    [-0.2,-0.98,92,0.8], [0.2,-0.98,92,0.8],
];
const SPARK_COLS  = ['#ffd700','#ffcc00','#ffff66','#ff9900','#fff5a0','#ffaa00'];
const SPARK_BRIGHT = ['#ffffff','#ffffd0','#ffffe8'];
const CRED = [
    ['gap',50],['title','S N A K E'],['sub','F O K   E D I T I O N'],['gap',60],
    ['hdr','--- CREDITS ---'],['gap',40],
    ['hdr','CONCEPTUAL SUPERVISION'],['txt','Jonas and Kai P.'],['gap',28],
    ['hdr','CREATIVE DIRECTION'],['txt','Jonas P.'],['gap',28],
    ['hdr','CREATIVE ADVISOR'],['txt','Maartje P.'],['gap',28],
    ['hdr','EXECUTIVE PRODUCTION'],['txt','Kai P.'],['gap',28],
    ['hdr','LEAD DEVELOPER'],['txt','Claude P.'],['sml','(types at 10,000 tokens/min)'],['gap',28],
    ['hdr','MUSICAL COMPOSITION'],['txt','Claude M.'],['sml','(self-taught. mostly.)'],['gap',28],
    ['hdr','VISUAL ARTS'],['txt','Claude V.'],['sml','(knows exactly 7 colors)'],['gap',28],
    ['hdr','QUALITY ASSURANCE'],['txt','The Snake'],['sml','(mortality rate: 100%)'],['gap',28],
    ['hdr','LEVEL DESIGN'],['txt','A Random Number Generator'],['sml','(certified barricade placement specialist)'],['gap',28],
    ['hdr','GEM MANAGEMENT'],['txt','The Gems'],['sml','(eaten without consent since 2026)'],['gap',28],
    ['hdr','STRUCTURAL ENGINEERING'],['txt','The Barricades'],['sml','(load-bearing. do not touch.)'],['gap',28],
    ['hdr','SNAKE PSYCHOLOGY'],['txt','Dr. S. Nake, PhD'],['sml','(expert in self-collision trauma)'],['gap',28],
    ['hdr','CATERING'],['txt','The Break Room Snake'],['sml','(she also ate the coffee machine)'],['gap',40],
    ['hdr','SPECIAL THANKS'],
    ['txt','Everyone who played.'],['txt','Everyone who crashed into themselves.'],
    ['txt','The one person who reached Level 10.'],['txt','You know who you are.'],['gap',40],
    ['hdr','IN MEMORIAM'],
    ['txt','All snakes lost in beta testing.'],['txt','They knew the risks.'],['gap',28],
    ['txt','No animals were harmed...'],['sml','(the snakes beg to differ)'],['gap',50],
    ['coins'],['sml','(spend them in the SHOP)'],['gap',50],
    ['sml','(C) 2026 FOK STUDIOS'],['sml','All wrongs reserved.'],
    ['gap',30],['txt','PRESS A TO EXIT'],['gap',280],
    ['gap',420],
    ['secret','No Eastereggs here ;)'],['gap',240],
];
const CRED_H = { title:54, sub:22, hdr:28, txt:26, sml:24, coins:28, secret:28 };
