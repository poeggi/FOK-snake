// Fail if any tracked text source contains non-ASCII bytes.
// Matches the standing ASCII-only rule for source, README and manifests.
// Run: node test/check-ascii.js   (exit 0 = clean, 1 = offenders listed)
const { execSync } = require('child_process');
const fs = require('fs');
const TEXT = /\.(js|css|html|md|json|ya?ml|sh|svg|txt)$/i;

const files = execSync('git ls-files', { encoding: 'utf8' })
    .split('\n').filter(f => f && TEXT.test(f));
const bad = [];
for (const f of files) {
    const buf = fs.readFileSync(f);
    for (let i = 0; i < buf.length; i++) {
        if (buf[i] > 127) {
            const line = buf.slice(0, i).toString('utf8').split('\n').length;
            bad.push(`${f}:${line}  byte 0x${buf[i].toString(16)}`);
            break;
        }
    }
}
if (bad.length) {
    console.error('Non-ASCII bytes found:\n' + bad.join('\n'));
    process.exit(1);
}
console.log(`ASCII OK (${files.length} files)`);
