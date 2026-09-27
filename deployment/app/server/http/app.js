/* HTTP application: API dispatch plus static delivery of the browser client.
 *
 * Only two API routes are reachable without a session (login and read-only
 * metadata). Everything else requires an authenticated account, and every
 * case-scoped route additionally requires membership of that case. */
'use strict';
const nodeHttp = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const config = require('../config');
const logger = require('../lib/logger');
const httpLib = require('../lib/http');
const { Router } = require('../lib/router');
const { AppError, unauthorized } = require('../lib/errors');
const contextFactory = require('./context');
const routes = require('./routes');

const STATIC_ROOT = path.resolve(__dirname, '..', '..', 'dist');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.csv': 'text/csv; charset=utf-8',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8'
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'"
].join('; ');

function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin) return {};
  if (!config.http.corsOrigins.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
    Vary: 'Origin'
  };
}

/* The server-connected workspace is the product. The browser-local demo is
 * archived under dist/demo/ and is only reachable at its explicit path. */
const DEFAULT_DOCUMENT = '/workspace.html';

async function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? DEFAULT_DOCUMENT
    : pathname === '/demo' || pathname === '/demo/' ? '/demo/index.html'
      : pathname;
  const file = path.resolve(STATIC_ROOT, `.${relative}`);
  if (file !== STATIC_ROOT && !file.startsWith(STATIC_ROOT + path.sep)) {
    return httpLib.send(res, 403, { error: { code: 'forbidden', message: 'Forbidden' } });
  }
  let data;
  try { data = await fs.readFile(file); } catch {
    return httpLib.send(res, 404, { error: { code: 'not_found', message: 'Not found' } });
  }
  const type = MIME[path.extname(file)] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': data.length,
    'Content-Security-Policy': CSP,
    ...httpLib.SECURITY_HEADERS
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

function createApp({ store }) {
  const router = routes.mountAll(new Router());

  return async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);
    const cors = corsHeaders(req);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...cors, ...httpLib.SECURITY_HEADERS });
      return res.end();
    }

    if (!pathname.startsWith('/api/')) {
      if (!['GET', 'HEAD'].includes(req.method)) {
        return httpLib.send(res, 405, { error: { code: 'method_not_allowed', message: 'Use GET for static files' } }, { Allow: 'GET, HEAD' });
      }
      return serveStatic(req, res, pathname);
    }

    const startedAt = Date.now();
    let status = 500;
    let ctx = null;
    try {
      const { route, params } = router.resolve(req.method, pathname);
      ctx = await contextFactory.build({ req, res, store, params, url });

      if (!routes.PUBLIC.has(route.pattern) && !ctx.actor) throw unauthorized('Sign in to use this API');

      const result = await route.handler(ctx);

      if (result && result.__binary) {
        status = 200;
        return httpLib.sendBinary(res, 200, result.__binary.buffer, {
          type: result.__binary.type,
          filename: result.__binary.filename,
          headers: { ...cors, ...(result.__binary.headers || {}) }
        });
      }
      const shaped = result && typeof result === 'object' && ('status' in result) && ('body' in result)
        ? result
        : { status: 200, body: result ?? {} };
      status = shaped.status;
      return httpLib.send(res, shaped.status, shaped.body, { ...cors, ...(shaped.headers || {}) });
    } catch (error) {
      const mapped = httpLib.errorBody(error);
      status = mapped.status;
      if (status >= 500) {
        logger.error('Request failed', { method: req.method, path: pathname, status, error: error.message, stack: error.stack?.split('\n')[1]?.trim() });
      }
      return httpLib.send(res, status, mapped.body, cors);
    } finally {
      // Request log: method, path, status, timing and actor role. No bodies, no tokens.
      logger.info('request', {
        method: req.method, path: pathname, status,
        ms: Date.now() - startedAt,
        role: ctx?.actor?.role || 'anonymous'
      });
    }
  };
}

function createServer({ store }) {
  const handler = createApp({ store });
  const server = nodeHttp.createServer((req, res) => {
    handler(req, res).catch(error => {
      logger.error('Unhandled request error', { error: error.message });
      if (!res.headersSent) httpLib.send(res, 500, { error: { code: 'internal_error', message: 'Unexpected server error' } });
    });
  });
  server.headersTimeout = 20000;
  server.requestTimeout = 60000;
  return server;
}

module.exports = { createApp, createServer, STATIC_ROOT, DEFAULT_DOCUMENT, CSP, AppError };
