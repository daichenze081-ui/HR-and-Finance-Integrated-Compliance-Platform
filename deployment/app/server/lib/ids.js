'use strict';
const crypto = require('node:crypto');

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32, no ambiguous glyphs

/** Sortable, collision-resistant identifier with a readable entity prefix. */
function id(prefix) {
  const time = Date.now();
  let stamp = '';
  for (let t = time, i = 0; i < 10; i++) { stamp = ALPHABET[t % 32] + stamp; t = Math.floor(t / 32); }
  const random = Array.from(crypto.randomBytes(8), b => ALPHABET[b % 32]).join('');
  return `${prefix}_${stamp}${random}`;
}

/** Opaque high-entropy secret for session tokens and signed links. */
const token = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

/** Deterministic zero-padded human sequence, for example RPT-003. */
const seq = (prefix, n, width = 3) => `${prefix}-${String(n).padStart(width, '0')}`;

module.exports = { id, token, seq };
