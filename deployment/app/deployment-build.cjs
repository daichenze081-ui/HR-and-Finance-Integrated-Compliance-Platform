'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const allowed = new Set(['workspace.html', 'workspace.js', 'api.js', 'styles.css', 'demo/index.html', 'demo/core.js', 'demo/app.js', 'demo/styles.css']);
for (const relative of allowed) {
  const destination = path.join(root, 'public', relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(root, 'dist', relative), destination);
}
// Fail closed if an unexpected file has entered the static output directory.
function verify(dir, prefix = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isSymbolicLink()) throw new Error('Static symlinks are not allowed');
    if (entry.isDirectory()) verify(path.join(dir, entry.name), relative + '/');
    else if (!allowed.has(relative)) throw new Error('Unexpected public file: ' + relative);
  }
}
verify(path.join(root, 'public'));
process.stdout.write('Built 8 allowlisted static assets; source code and evidence are not public assets.\n');
