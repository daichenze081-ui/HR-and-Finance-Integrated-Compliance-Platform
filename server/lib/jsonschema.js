/* Minimal JSON Schema checker covering the subset used by the agent tool
 * declarations. Tool arguments arrive from a language model and are untrusted, so
 * they are checked against the declared schema before any tool runs; unknown
 * properties are refused rather than ignored. */
'use strict';
const { badRequest } = require('./errors');

function fail(path, message) {
  throw badRequest(`${path || 'input'} ${message}`);
}

function check(value, schema, path = 'input') {
  if (!schema || typeof schema !== 'object') return value;

  if (schema.enum && !schema.enum.includes(value)) fail(path, `must be one of: ${schema.enum.join(', ')}`);

  switch (schema.type) {
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'must be an object');
      const properties = schema.properties || {};
      for (const key of schema.required || []) {
        if (value[key] === undefined || value[key] === null) fail(`${path}.${key}`, 'is required');
      }
      if (schema.additionalProperties === false) {
        const extra = Object.keys(value).filter(key => !Object.hasOwn(properties, key));
        if (extra.length) fail(path, `contains unsupported propert${extra.length === 1 ? 'y' : 'ies'}: ${extra.join(', ')}`);
      }
      if (schema.maxProperties && Object.keys(value).length > schema.maxProperties) {
        fail(path, `must contain at most ${schema.maxProperties} properties`);
      }
      const out = {};
      for (const [key, inner] of Object.entries(value)) {
        out[key] = Object.hasOwn(properties, key) ? check(inner, properties[key], `${path}.${key}`) : inner;
      }
      return out;
    }
    case 'array': {
      if (!Array.isArray(value)) fail(path, 'must be an array');
      if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(path, `must contain at most ${schema.maxItems} items`);
      if (schema.minItems !== undefined && value.length < schema.minItems) fail(path, `must contain at least ${schema.minItems} items`);
      return value.map((item, index) => check(item, schema.items, `${path}[${index}]`));
    }
    case 'string': {
      if (typeof value !== 'string') fail(path, 'must be a string');
      if (schema.maxLength !== undefined && value.length > schema.maxLength) fail(path, `must be at most ${schema.maxLength} characters`);
      if (schema.minLength !== undefined && value.length < schema.minLength) fail(path, `must be at least ${schema.minLength} characters`);
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail(path, 'has an unsupported format');
      return value;
    }
    case 'integer': {
      if (!Number.isInteger(value)) fail(path, 'must be a whole number');
      if (schema.minimum !== undefined && value < schema.minimum) fail(path, `must be at least ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) fail(path, `must be at most ${schema.maximum}`);
      return value;
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'must be a number');
      return value;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') fail(path, 'must be true or false');
      return value;
    }
    default:
      return value;
  }
}

module.exports = { check };
