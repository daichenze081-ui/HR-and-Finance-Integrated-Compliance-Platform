/* AWS Signature Version 4 signing, implemented on node:crypto.
 *
 * Written directly rather than pulled from the AWS SDK so the server keeps a
 * single small dependency set and the signing behaviour is auditable in one file.
 * Credentials are read at call time from the process environment and are never
 * logged, cached on disk or sent to the browser. */
'use strict';
const crypto = require('node:crypto');
const https = require('node:https');

const ALGORITHM = 'AWS4-HMAC-SHA256';
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data, 'utf8').digest();
const sha256Hex = data => crypto.createHash('sha256').update(data).digest('hex');

const encodeSegment = segment => encodeURIComponent(segment)
  .replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

const canonicalPath = path => path.split('/').map(encodeSegment).join('/');

function canonicalQuery(query = {}) {
  return Object.keys(query).sort()
    .map(key => `${encodeSegment(key)}=${encodeSegment(String(query[key]))}`)
    .join('&');
}

function amzDate(date = new Date()) {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { full: iso, short: iso.slice(0, 8) };
}

/**
 * @returns {{headers: object, authorization: string}} headers to send, including Authorization.
 */
function sign({ method, host, path = '/', query = {}, headers = {}, body = '', service, region, credentials, date = new Date() }) {
  if (!credentials?.accessKeyId || !credentials?.secretAccessKey) {
    const error = new Error('AWS credentials are not configured');
    error.code = 'no_credentials';
    throw error;
  }
  const stamp = amzDate(date);
  const payloadBuffer = Buffer.isBuffer(body) ? body : Buffer.from(body || '', 'utf8');
  const payloadHash = sha256Hex(payloadBuffer);

  const signed = {
    host,
    'x-amz-date': stamp.full,
    'x-amz-content-sha256': payloadHash,
    ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()]))
  };
  if (credentials.sessionToken) signed['x-amz-security-token'] = credentials.sessionToken;

  const names = Object.keys(signed).sort();
  const canonicalHeaders = `${names.map(name => `${name}:${signed[name]}`).join('\n')}\n`;
  const signedHeaders = names.join(';');

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalPath(path),
    canonicalQuery(query),
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');

  const scope = `${stamp.short}/${region}/${service}/aws4_request`;
  const stringToSign = [ALGORITHM, stamp.full, scope, sha256Hex(canonicalRequest)].join('\n');

  const signingKey = ['AWS4' + credentials.secretAccessKey, stamp.short, region, service, 'aws4_request']
    .reduce((key, part) => hmac(key, part));
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  const authorization = `${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers: { ...signed, authorization }, authorization, payloadHash };
}

/** Signed HTTPS request with an explicit timeout. Response body is returned raw. */
function request({ method, host, path, query, headers, body, service, region, credentials, timeoutMs = 30000 }) {
  const signature = sign({ method, host, path, query, headers, body, service, region, credentials });
  const search = canonicalQuery(query || {});
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body || '', 'utf8');

  return new Promise((resolve, reject) => {
    const req = https.request({
      method,
      host,
      path: `${canonicalPath(path)}${search ? `?${search}` : ''}`,
      headers: { ...signature.headers, 'content-length': payload.length },
      timeout: timeoutMs
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => { req.destroy(Object.assign(new Error(`AWS request timed out after ${timeoutMs} ms`), { code: 'timeout' })); });
    req.on('error', reject);
    if (payload.length) req.write(payload);
    req.end();
  });
}

module.exports = { sign, request, sha256Hex, canonicalQuery };
