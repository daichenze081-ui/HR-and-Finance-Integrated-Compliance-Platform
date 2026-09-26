/* Single source of server time. Tests can freeze it so digests and snapshots are
 * reproducible; application code never calls Date.now() directly. */
'use strict';

let fixed = null;

const now = () => (fixed ? fixed : new Date().toISOString());
const millis = () => (fixed ? Date.parse(fixed) : Date.now());
const plusMinutes = (minutes, from = now()) => new Date(Date.parse(from) + minutes * 60000).toISOString();
const isPast = (iso, reference = now()) => !!iso && Date.parse(iso) <= Date.parse(reference);
const isIso = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

module.exports = {
  now, millis, plusMinutes, isPast, isIso,
  freeze(iso) { fixed = iso; },
  unfreeze() { fixed = null; }
};
