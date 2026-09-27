/* Input validation for untrusted data: request bodies, uploaded metadata, CSV
 * cells and model tool arguments all pass through here. Nothing downstream may
 * assume a shape that was not checked. */
'use strict';
const { badRequest } = require('./errors');

const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const CONTROL_MULTILINE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

function object(value, label = 'Body') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest(`${label} must be a JSON object`);
  return value;
}

function text(value, label, { max = 200, min = 1, multiline = false, pattern = null } = {}) {
  if (typeof value !== 'string') throw badRequest(`${label} must be text`);
  const trimmed = value.trim();
  if (trimmed.length < min) throw badRequest(`${label} is required`);
  if (trimmed.length > max) throw badRequest(`${label} must be at most ${max} characters`);
  const probe = multiline ? trimmed.replace(/[\r\n\t]/g, '') : trimmed;
  if ((multiline ? CONTROL_MULTILINE : CONTROL).test(probe) || (!multiline && /[\r\n\t]/.test(trimmed))) {
    throw badRequest(`${label} contains unsupported control characters`);
  }
  if (pattern && !pattern.test(trimmed)) throw badRequest(`${label} has an unsupported format`);
  return trimmed;
}

const optionalText = (value, label, opts = {}) =>
  (value === undefined || value === null || value === '' ? '' : text(value, label, { ...opts, min: 0 }));

const ident = (value, label) => text(value, label, { max: 64, pattern: /^[A-Za-z0-9_-]{1,64}$/ });
const entityId = (value, label) => text(value, label, { max: 80, pattern: /^[A-Za-z0-9_:-]{1,80}$/ });
const period = (value, label = 'Period') => text(value, label, { max: 7, pattern: /^\d{4}-(0[1-9]|1[0-2])$/ });

function oneOf(value, allowed, label) {
  if (!allowed.includes(value)) throw badRequest(`${label} must be one of: ${allowed.join(', ')}`);
  return value;
}

function integer(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`${label} must be a whole number between ${min} and ${max}`);
  return n;
}

function array(value, label, { max = 500, min = 1 } = {}) {
  if (!Array.isArray(value)) throw badRequest(`${label} must be a list`);
  if (value.length < min) throw badRequest(`${label} must contain at least ${min} item${min === 1 ? '' : 's'}`);
  if (value.length > max) throw badRequest(`${label} must contain at most ${max} items`);
  return value;
}

function isoTimestamp(value, label) {
  const s = text(value, label, { max: 40 });
  if (!Number.isFinite(Date.parse(s))) throw badRequest(`${label} must be an ISO-8601 timestamp`);
  return new Date(s).toISOString();
}

/** Rejects unexpected properties so callers cannot smuggle fields into writes. */
function only(value, allowed, label = 'Body') {
  const body = object(value, label);
  const extra = Object.keys(body).filter(k => !allowed.includes(k));
  if (extra.length) throw badRequest(`${label} contains unsupported field${extra.length === 1 ? '' : 's'}: ${extra.join(', ')}`);
  return body;
}

/** Filenames from uploads are untrusted: strip directories and shell-hostile characters. */
function filename(value, label = 'File name') {
  const base = String(value ?? '').split(/[\\/]/).pop() || '';
  const cleaned = base.replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') throw badRequest(`${label} is not a usable file name`);
  if (cleaned.length > 180) throw badRequest(`${label} must be at most 180 characters`);
  return cleaned;
}

module.exports = {
  object, only, text, optionalText, ident, entityId, period,
  oneOf, integer, array, isoTimestamp, filename
};
