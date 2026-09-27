'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const files = [];
function collect(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.vercel', 'public', 'var', '.git'].includes(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(file);
    else if (/\.(cjs|js)$/.test(entry.name)) files.push(file);
  }
}
collect(__dirname);
for (const file of files) execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
process.stdout.write('Checked ' + files.length + ' deployment JavaScript files; 0 failures.\n');
