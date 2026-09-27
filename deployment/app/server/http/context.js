/* Per-request context.
 *
 * A handler receives exactly one object. It carries the authenticated actor, the
 * data store, route parameters and bounded body readers. Handlers never touch
 * req/res directly except for binary responses, which keeps the business services
 * free of HTTP concerns and replaceable behind the same API. */
'use strict';
const config = require('../config');
const http = require('../lib/http');
const clock = require('../lib/clock');
const { unauthorized, badRequest } = require('../lib/errors');
const sessions = require('../auth/sessions');
const rbac = require('../auth/rbac');

function bearer(req) {
  const header = String(req.headers.authorization || '');
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket?.remoteAddress || null;
}

async function build({ req, res, store, params, url }) {
  const cookies = http.parseCookies(req.headers.cookie);
  const token = bearer(req) || cookies[config.session.cookie] || null;
  const resolved = token ? await sessions.resolve(store, token) : null;

  const ctx = {
    req,
    res,
    store,
    params: params || {},
    query: Object.fromEntries(url.searchParams.entries()),
    ip: clientIp(req),
    at: clock.now(),
    token,
    session: resolved?.session || null,
    actor: resolved
      ? {
        id: resolved.user.id,
        role: resolved.user.role,
        email: resolved.user.email,
        displayName: resolved.user.display_name,
        permissions: rbac.permissionsFor(resolved.user.role)
      }
      : null,

    /** Bounded JSON body. Absent body yields {}. */
    async json() {
      if (ctx._body === undefined) ctx._body = await http.readJson(req, config.http.maxJsonBytes);
      return ctx._body;
    },

    /** Raw bytes, used for evidence uploads. */
    async raw(maxBytes = config.evidence.maxBytes) {
      if (ctx._raw === undefined) ctx._raw = await http.readBody(req, maxBytes);
      return ctx._raw;
    },

    requireActor() {
      if (!ctx.actor) throw unauthorized('Sign in to use this API');
      return ctx.actor;
    },

    requirePermission(permission) {
      ctx.requireActor();
      rbac.requirePermission(ctx.actor.role, permission);
      return true;
    },

    param(name) {
      const value = ctx.params[name];
      if (!value) throw badRequest(`Missing path parameter: ${name}`);
      return decodeURIComponent(value);
    }
  };
  return ctx;
}

module.exports = { build, clientIp };
