'use strict';
const crypto = require('node:crypto');

const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

/** Stable JSON so digests do not change when key insertion order changes. */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

const digest = value => sha256(Buffer.from(canonical(value), 'utf8'));

/** Constant-time comparison for tokens and digests. */
function equals(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

module.exports = { sha256, canonical, digest, equals };
