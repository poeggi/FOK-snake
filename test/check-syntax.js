// Parse every shipped source in ONE process. Equivalent to `node --check js/*.js`, but
// that spawned a fresh node per file (~40ms each) for a check that is pure parsing --
// vm.Script compiles a script exactly the way --check does, duplicate top-level
// declarations and all, so the guard is unchanged and the process count is 1.
const fs = require('fs'), vm = require('vm');

const files = fs.readdirSync('js').filter(f => f.endsWith('.js')).sort();
if(!files.length){ console.error('check-syntax: js/ has no sources -- wrong cwd?'); process.exit(1); }

let bad = 0;
for(const f of files){
    const p = 'js/' + f;
    try { new vm.Script(fs.readFileSync(p, 'utf8'), { filename: p }); }
    catch(e){ console.error(p + ': ' + e.message); bad++; }
}
if(bad) process.exit(1);
console.log('parsed ' + files.length + ' shipped sources');
