// ================================================================
// STATIC GAME DATA
// ================================================================
const COLS = 30, ROWS = 20, CS = 20;
const CW = COLS * CS, CH = ROWS * CS;
const GEMS_PER_LEVEL = 10, MAX_LEVELS = 10, START_LIVES = 3;
const HEART_PX = [[0,1,1,0,1,1,0],[1,1,1,1,1,1,1],[1,1,1,1,1,1,1],[0,1,1,1,1,1,0],[0,0,1,1,1,0,0],[0,0,0,1,0,0,0]];
// Speaker split into two 8x8 icons drawn side by side (total 32x16px at CS=2)
// BODY: cone only (cols 0-3). WAVES: 3 arcs inner(col1,rows3-4) mid(col3,rows2-5) outer(col5,rows1-6). X: diagonal cross for muted.
const SPEAKER_BODY  = [[0,0,0,1,0,0,0,0],[0,0,1,1,0,0,0,0],[1,1,1,1,0,0,0,0],[1,1,1,1,0,0,0,0],[1,1,1,1,0,0,0,0],[1,1,1,1,0,0,0,0],[0,0,1,1,0,0,0,0],[0,0,0,1,0,0,0,0]];
const SPEAKER_WAVES = [[0,0,0,0,0,0,0,0],[0,0,0,0,0,1,0,0],[0,0,0,1,0,1,0,0],[0,1,0,1,0,1,0,0],[0,1,0,1,0,1,0,0],[0,0,0,1,0,1,0,0],[0,0,0,0,0,1,0,0],[0,0,0,0,0,0,0,0]];
const SPEAKER_X     = [[0,0,0,0,0,0,0,0],[0,1,0,0,0,1,0,0],[0,0,1,0,1,0,0,0],[0,0,0,1,0,0,0,0],[0,0,0,1,0,0,0,0],[0,0,1,0,1,0,0,0],[0,1,0,0,0,1,0,0],[0,0,0,0,0,0,0,0]];
// Pixel art standard: CS=2 (1 artwork pixel = 2x2 screen pixels)
// Icons (achievements, shop, speaker): 8x8 artwork -> 16x16px on screen
// Coin: 16x16 artwork -> 32x32px on screen
// Coin symbol pixel grids — [col, row] pairs, drawn at cs=2, centered in coin face
// "1": 4x6 simple (angled top, no base)  (screen: 8x12px)
const SYM_ONE = { w:4, h:6, px:[[2,0],[1,1],[2,1],[2,2],[2,3],[2,4],[2,5]] };
// "¥": 5x7 yen  (screen: 10x14px)
const SYM_YEN = { w:5, h:7, px:[[0,0],[4,0],[1,1],[3,1],[2,2],[0,3],[1,3],[2,3],[3,3],[4,3],[2,4],[0,5],[1,5],[2,5],[3,5],[4,5],[2,6]] };
const DEATH_DUR = 900, LEVELDONE_DUR = 1400, READY_DUR = 1000, GO_DUR = 300;
const MAX_NAME = 15;
const NAME_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ_-!?.,\'"#$@&()+ \r';

const LEVEL_CFG = [
    { easy:260, normal:210, hard:150, bars:0  },
    { easy:240, normal:190, hard:140, bars:2  },
    { easy:220, normal:180, hard:130, bars:4  },
    { easy:210, normal:160, hard:120, bars:6  },
    { easy:190, normal:150, hard:110, bars:8  },
    { easy:170, normal:140, hard:100, bars:10 },
    { easy:150, normal:120, hard:90,  bars:12 },
    { easy:140, normal:110, hard:80,  bars:14 },
    { easy:120, normal:90,  hard:70,  bars:16 },
    { easy:100, normal:80,  hard:60,  bars:18 },
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
    { id:'level1',        name:'RISING SNAKE',  desc:'Complete level 1',
      icon:{p:{A:'#7fff7f',B:'#001500'},d:['.AAAAAA.','AAAAAAAA','AAAAAAAA','ABAAAAAB','AAAAAAAA','AAAAAAAA','.AAAAAA.','........']}},
    { id:'fokoins_1k',    name:'POCKET CHANGE', desc:'Earn 5,000 FOKoins',
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
    { id:'score_25k',     name:'HIGH ROLLER',   desc:'Score 64,000 in one game',
      icon:{p:{A:'#ff4400',B:'#ff9900',C:'#ffdd00'},d:['...A....','..ABA...','.ABBBA..','ABBBBA..','ABCBBBA.','ABCCCBA.','.AAAAAA.','........']}},
];

const EXPERT_ACHIEVEMENTS = [
    { id:'score_100k',  name:'SCORE HUNTER',  desc:'Score 100,000 in one game',
      icon:{p:{A:'#ff8800',B:'#cc5500'},
      d:['A.AA.AA.','AAAAAAAA','ABBBBBBA','ABBBBBBA','ABBBBBBA','AAAAAAAA','.AAAAAA.','........']}},
    { id:'perfect_level', name:'PERFECTIONIST', desc:'Complete a level perfectly',
      icon:{p:{A:'#ffd700',B:'#cc8800'},
      d:['A..A..A.','AAAAAAA.','AAAAAAA.','AAAAAAA.','BAAAAAAB','BAAAAAAB','........','........']}},
    { id:'hard_champ',  name:'IRON SNAKE',    desc:'Beat all 10 levels on hard',
      icon:{p:{A:'#cccccc',B:'#888888'},
      d:['.AAAAAA.','AAAAAAAA','ABBBBBBA','ABBBBBBA','.AAAAAA.','..AAAA..','...AA...','........']}},
    { id:'triple_perf', name:'TRIPLE ACE',    desc:'3 perfect levels in one game',
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
    { id:'fokoins_100k', name:'DRAGON RICH',  desc:'Earn 5,000,000 total FOKoins',
      icon:{p:{A:'#888888',B:'#333333',C:'#cccccc',D:'#eeeeee'},
      d:['AAAAAAAA','ACDDDDCA','ADDDDDDA','ADDBDDDA','ADDDDDDA','ACDDDDCA','AAAAAAAA','........']}},
];

const SHOP_ITEMS = [
    { id:'necktie',  name:'NECKTIE',       desc:'Business on the grid',           price:25000,
      icon:{p:{A:'#2a52be',B:'#1a3a8e',C:'#5a82ee'},d:['...BB...','...BB...','...AA...','..AAAA..','..ACCA..','..AAAA..','...AA...','........']}},
    { id:'shades',   name:'SUNGLASSES',    desc:'Too cool for the grid',          price:50000,
      icon:{p:{A:'#111111',B:'#1a3050'},d:['.AAA.AAA','ABBBABBB','ABBBABBB','.AAA.AAA','........','........','........','........']}},
    { id:'cylinder', name:'CYLINDER HAT',  desc:'A distinguished top hat',       price:100000,
      icon:{p:{A:'#1a1a1a',B:'#333333'},d:['........','..AAAA..','..AAAA..','..AAAA..','.BBBBBB.','........','........','........']}},
    { id:'donate',   name:'DONATE',        desc:'Support the dev. Repeatable!',  price:100000, repeatable:true,
      icon:{p:{A:'#ff4499',B:'#ff88cc'},d:['.AA.AA..','AAAAAAA.','AAAAAAA.','.AAAAA..','..AAA...','...A....','........','........']}},
    { id:'monocle',  name:'MONOCLE',       desc:'For the refined serpent',        price:150000,
      icon:{p:{H:'#d8d8d8',A:'#999999',S:'#484848',G:'#eeeeee',C:'#aaaaaa',D:'#555555'},d:['..HHAA..','.H....A.','.H.G..A.','.A....S.','..AASS..','.....CD.','....CD..','...CD...']}},
    { id:'bow',      name:'BOW TIE',       desc:'Charming and aerodynamic',       price:250000,
      icon:{p:{A:'#cc2222',B:'#ff4444',C:'#aa0000'},d:['........','AA...AA.','ABBACBBA','AABACBAA','AA...AA.','........','........','........']}},
    { id:'crown',    name:'ROYAL CROWN',   desc:'Fit for a snake king',           price:1000000,
      icon:{p:{A:'#ffd700',C:'#ff4444'},d:['A..A..A.','AAAAAAA.','ACAAACA.','AAAAAAA.','........','........','........','........']}},
];
