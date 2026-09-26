/* Password hashing with scrypt from the Node standard library. Hashes and salts
 * stay server-side; plaintext is never stored, logged or returned. */
'use strict';
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { badRequest } = require('../lib/errors');

const scrypt = promisify(crypto.scrypt);
const KEY_LENGTH = 64;
const PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function assertStrength(password) {
  if (typeof password !== 'string' || password.length < 10) throw badRequest('Passwords must be at least 10 characters');
  if (password.length > 200) throw badRequest('Passwords must be at most 200 characters');
  return password;
}

async function hash(password) {
  assertStrength(password);
  const salt = crypto.randomBytes(16).toString('base64');
  const derived = await scrypt(password, salt, KEY_LENGTH, PARAMS);
  return { hash: derived.toString('base64'), salt };
}

async function verify(password, stored) {
  if (typeof password !== 'string' || !stored?.hash || !stored?.salt) return false;
  if (password.length > 200) return false;
  let derived;
  try { derived = await scrypt(password, stored.salt, KEY_LENGTH, PARAMS); } catch { return false; }
  const expected = Buffer.from(stored.hash, 'base64');
  if (expected.length !== derived.length) return false;
  return crypto.timingSafeEqual(expected, derived);
}

module.exports = { hash, verify, assertStrength };
