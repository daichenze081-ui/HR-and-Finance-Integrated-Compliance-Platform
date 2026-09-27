/* Request/response helpers: bounded body reading, JSON parsing, cookies and
 * consistent error shaping. */
'use strict';
const { badRequest, tooLarge, AppError } = require('./errors');

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY'
};

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = error => { if (!settled) { settled = true; req.destroy(); reject(error); } };
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) return fail(tooLarge(`Request body must not exceed ${maxBytes} bytes`));
      chunks.push(chunk);
    });
    req.on('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', fail);
  });
}

async function readJson(req, maxBytes) {
  const raw = await readBody(req, maxBytes);
  if (!raw.length) return {};
  const type = String(req.headers['content-type'] || '');
  if (!/^application\/json\b/i.test(type)) throw badRequest('Content-Type must be application/json');
  try { return JSON.parse(raw.toString('utf8')); } catch { throw badRequest('Request body is not valid JSON'); }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function cookie(name, value, { maxAgeSeconds, secure = false } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (secure) parts.push('Secure');
  parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSeconds ?? 0))}`);
  return parts.join('; ');
}

function send(res, status, payload, headers = {}) {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...SECURITY_HEADERS,
    ...headers
  });
  res.end(body);
}

function sendBinary(res, status, buffer, { type = 'application/octet-stream', filename, headers = {} } = {}) {
  const extra = { ...headers };
  if (filename) extra['Content-Disposition'] = `attachment; filename="${filename.replace(/["\\]/g, '')}"`;
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': buffer.length,
    ...SECURITY_HEADERS,
    ...extra
  });
  res.end(buffer);
}

/** Maps any thrown value to a client-safe error body. Internals are not leaked. */
function errorBody(error) {
  if (error instanceof AppError) {
    const body = { error: { code: error.code, message: error.message } };
    if (error.detail !== undefined) body.error.detail = error.detail;
    return { status: error.status, body };
  }
  // Validation thrown by the shared core engine carries useful, non-sensitive text.
  if (error instanceof Error && error.name === 'Error' && error.message && error.message.length < 400) {
    return { status: 400, body: { error: { code: 'invalid_request', message: error.message } } };
  }
  return { status: 500, body: { error: { code: 'internal_error', message: 'Unexpected server error' } } };
}

module.exports = { readBody, readJson, parseCookies, cookie, send, sendBinary, errorBody, SECURITY_HEADERS };
