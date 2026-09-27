/* Structured console logging with secret redaction. Never log credentials,
 * session tokens, password hashes or raw evidence content. */
'use strict';

const SECRET_KEY = /(secret|password|token|credential|authorization|apikey|api_key|access_key|signature)/i;
const REDACTED = '[redacted]';

function scrub(value, depth = 0) {
  if (depth > 6) return '[depth-limit]';
  if (value instanceof Error) return { error: value.message, code: value.code };
  if (Buffer.isBuffer(value)) return `[binary ${value.length} bytes]`;
  if (Array.isArray(value)) return value.slice(0, 40).map(v => scrub(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, inner] of Object.entries(value)) out[key] = SECRET_KEY.test(key) ? REDACTED : scrub(inner, depth + 1);
    return out;
  }
  if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}…[truncated]`;
  return value;
}

let sink = line => process.stdout.write(`${line}\n`);

function emit(level, message, fields) {
  const entry = { at: new Date().toISOString(), level, message };
  if (fields && Object.keys(fields).length) entry.fields = scrub(fields);
  sink(JSON.stringify(entry));
}

module.exports = {
  info: (message, fields) => emit('info', message, fields),
  warn: (message, fields) => emit('warn', message, fields),
  error: (message, fields) => emit('error', message, fields),
  scrub,
  /** Tests silence output without patching the console. */
  setSink(fn) { sink = typeof fn === 'function' ? fn : (() => {}); }
};
