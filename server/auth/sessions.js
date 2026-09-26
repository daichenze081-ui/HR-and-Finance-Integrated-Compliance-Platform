/* Opaque server-side sessions. Only a SHA-256 hash of the token is stored, so a
 * database copy does not yield usable credentials. Enterprise SSO is deferred;
 * these are local accounts with separate credentials per role. */
'use strict';
const config = require('../config');
const clock = require('../lib/clock');
const { id, token } = require('../lib/ids');
const { sha256 } = require('../lib/hash');
const { unauthorized, badRequest } = require('../lib/errors');
const passwords = require('./passwords');
const validate = require('../lib/validate');

const EMAIL = /^[^@\s]{1,64}@[^@\s.]{1,63}(\.[^@\s.]{1,63})+$/;

async function findUserByEmail(store, email) {
  return store.findOne('users', { email: String(email || '').trim().toLowerCase() });
}

async function login(store, { email, password, userAgent = '' }) {
  const address = validate.text(String(email || '').toLowerCase(), 'Email', { max: 160, pattern: EMAIL });
  if (typeof password !== 'string' || !password) throw badRequest('Password is required');
  const user = await findUserByEmail(store, address);
  const ok = user && user.active === 1 && await passwords.verify(password, { hash: user.password_hash, salt: user.password_salt });
  // Uniform failure message: does not disclose whether the account exists.
  if (!ok) throw unauthorized('Email or password is incorrect');

  const raw = token(32);
  const session = await store.insert('sessions', {
    id: id('ses'),
    user_id: user.id,
    token_hash: sha256(raw),
    created_at: clock.now(),
    expires_at: clock.plusMinutes(config.session.ttlMinutes),
    revoked_at: null,
    user_agent: String(userAgent || '').slice(0, 200)
  });
  await store.update('users', user.id, { last_login_at: clock.now() });
  return { token: raw, session, user };
}

async function resolve(store, rawToken) {
  if (!rawToken || typeof rawToken !== 'string' || rawToken.length > 200) return null;
  const session = await store.findOne('sessions', { token_hash: sha256(rawToken) });
  if (!session || session.revoked_at) return null;
  if (clock.isPast(session.expires_at)) return null;
  const user = await store.get('users', session.user_id);
  if (!user || user.active !== 1) return null;
  return { session, user };
}

async function logout(store, rawToken) {
  const found = await resolve(store, rawToken);
  if (!found) return false;
  await store.update('sessions', found.session.id, { revoked_at: clock.now() });
  return true;
}

/** Public view of an account. Never includes hash, salt or session token. */
const publicUser = user => ({
  id: user.id,
  email: user.email,
  displayName: user.display_name,
  role: user.role,
  lastLoginAt: user.last_login_at || null
});

module.exports = { login, resolve, logout, publicUser, findUserByEmail };
