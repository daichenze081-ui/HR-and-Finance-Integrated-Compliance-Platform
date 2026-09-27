'use strict';
const MAX_PAYLOAD = 4000000;
function cloudEnvironment(env = process.env) {
  const missing = [];
  const evidenceDriver = env.EVIDENCE_DRIVER || 'blob';
  if (!['blob', 's3'].includes(evidenceDriver)) throw new Error('The cloud app requires private Blob or S3 evidence storage');
  const required = ['DATABASE_URL', 'SESSION_SECRET', ...(evidenceDriver === 'blob'
    ? ['BLOB_READ_WRITE_TOKEN'] : ['S3_BUCKET', 'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'])];
  if (env.MODEL_DRIVER === 'bedrock') required.push('AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY');
  for (const name of new Set(required)) {
    if (!String(env[name] || '').trim()) missing.push(name);
  }
  if (missing.length) throw new Error('Missing cloud configuration names: ' + missing.join(', '));
  if (env.DB_DRIVER && env.DB_DRIVER !== 'postgres') throw new Error('The cloud app requires PostgreSQL persistence');
  if (String(env.SESSION_SECRET).length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters');
  if (env.MODEL_DRIVER && !['mock', 'bedrock'].includes(env.MODEL_DRIVER)) throw new Error('Use mock or configured Bedrock on this cloud deployment');
  let database;
  try { database = new URL(env.DATABASE_URL); } catch { throw new Error('DATABASE_URL is not a valid PostgreSQL URL'); }
  if (!['postgres:', 'postgresql:'].includes(database.protocol)) throw new Error('DATABASE_URL must use the PostgreSQL protocol');
  const sslmode = database.searchParams.get('sslmode');
  if (sslmode && sslmode !== 'verify-full') throw new Error('DATABASE_URL sslmode must be verify-full, or omitted with PGSSLMODE=require');
  env.DB_DRIVER = 'postgres';
  env.EVIDENCE_DRIVER = evidenceDriver;
  env.NODE_ENV = 'production';
  env.PGSSLMODE = 'require';
  env.MODEL_DRIVER ||= 'mock';
  for (const name of ['MAX_JSON_BYTES', 'EVIDENCE_MAX_BYTES']) {
    const requested = Number(env[name]);
    env[name] = String(Number.isSafeInteger(requested) && requested > 0 ? Math.min(MAX_PAYLOAD, requested) : MAX_PAYLOAD);
  }
  return env;
}

function failure(res, status, code, message) {
  const body = JSON.stringify({ error: { code, message } });
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

function createEntry({ initialize }) {
  let initialization;
  const ready = () => {
    // One promise per warm instance, including simultaneous cold-start requests.
    if (!initialization) initialization = Promise.resolve().then(initialize).catch(error => {
      initialization = undefined;
      throw error;
    });
    return initialization;
  };
  return async function entry(req, res) {
    const length = Number(req.headers['content-length'] || 0);
    if (length > MAX_PAYLOAD) return failure(res, 413, 'payload_too_large', 'The cloud upload limit is 4 MB per request.');
    let app;
    try { app = await ready(); } catch {
      // No connection strings, storage keys or provider errors go to a browser.
      return failure(res, 503, 'cloud_not_ready', 'Cloud database or private evidence storage is not ready. Contact the deployment owner.');
    }
    try { await app(req, res); } catch {
      if (!res.headersSent) failure(res, 500, 'internal_error', 'The request could not be completed.');
      else if (!res.writableEnded) res.end();
    }
  };
}
module.exports = { MAX_PAYLOAD, cloudEnvironment, createEntry };
