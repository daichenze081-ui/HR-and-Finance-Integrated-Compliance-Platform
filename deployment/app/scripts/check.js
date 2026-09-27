/* Syntax check across the browser client, the server and the scripts.
 * Replaces the previous two-file "node --check" so new code cannot skip the check. */
'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ROOTS = ['dist', 'server', 'scripts', 'tests'];
const SKIP = new Set(['node_modules', 'var', '.git']);

function collect(directory, found = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(full, found);
    else if (/\.(c?js|mjs)$/.test(entry.name)) found.push(full);
  }
  return found;
}

const files = ROOTS
  .map(name => path.join(ROOT, name))
  .filter(directory => fs.existsSync(directory))
  .flatMap(directory => collect(directory));

let failures = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    failures++;
    process.stderr.write(`${path.relative(ROOT, file)}\n${error.stderr?.toString() || error.message}\n`);
  }
}

process.stdout.write(`Checked ${files.length} file(s); ${failures} failure(s).\n`);
process.exit(failures ? 1 : 0);
