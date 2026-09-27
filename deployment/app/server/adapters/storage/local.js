/* Protected local evidence storage.
 *
 * Content-addressed: the object key contains the SHA-256 of the bytes, so a
 * stored object cannot be replaced by different content under the same key.
 * Files are written with owner-only permissions and are never inside the served
 * static directory, so they can only be reached through an authorised API route. */
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { notFound, badRequest } = require('../../lib/errors');

const KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;

class LocalEvidenceStorage {
  constructor({ dir }) {
    this.driver = 'local';
    this.root = path.resolve(dir);
  }

  resolve(key) {
    if (!KEY.test(key) || key.includes('..')) throw badRequest('Unsupported storage key');
    const file = path.resolve(this.root, key);
    if (file !== this.root && !file.startsWith(this.root + path.sep)) throw badRequest('Storage key escapes the evidence directory');
    return file;
  }

  async init() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    // A stray index file would otherwise make the directory browsable if it were
    // ever mapped into a web root by mistake.
    await fs.writeFile(path.join(this.root, '.gitignore'), '*\n!.gitignore\n', { mode: 0o600 }).catch(() => {});
    return this;
  }

  async put(key, buffer) {
    const file = this.resolve(key);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, buffer, { mode: 0o600 });
    await fs.rename(temporary, file);
    return { key, driver: this.driver, bytes: buffer.length };
  }

  async get(key) {
    try { return await fs.readFile(this.resolve(key)); } catch { throw notFound('Stored evidence object is missing'); }
  }

  async exists(key) {
    try { await fs.access(this.resolve(key)); return true; } catch { return false; }
  }

  async remove() {
    // Evidence is never deleted through the application. Superseding creates a new
    // version and the previous object is retained.
    throw badRequest('Evidence objects cannot be deleted. Upload a new version instead.');
  }

  describe() {
    return { driver: 'local', state: 'live', detail: `Protected local directory ${this.root}`, immutable: true };
  }
}

module.exports = { LocalEvidenceStorage };
