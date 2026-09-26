/* Dependency-free path router. Routes are declared as "METHOD /literal/:param"
 * so the HTTP surface stays readable and each business area can register its own
 * table independently of the others. */
'use strict';
const { notFound, AppError } = require('./errors');

function compile(pattern) {
  const [method, rawPath] = pattern.split(/\s+/);
  const segments = rawPath.split('/').filter(Boolean);
  return { method: method.toUpperCase(), segments, pattern };
}

function match(route, method, segments) {
  if (route.method !== method) return null;
  if (route.segments.length !== segments.length) return null;
  const params = {};
  for (let i = 0; i < route.segments.length; i++) {
    const expected = route.segments[i];
    if (expected.startsWith(':')) params[expected.slice(1)] = segments[i];
    else if (expected !== segments[i]) return null;
  }
  return params;
}

class Router {
  constructor() { this.routes = []; }

  add(pattern, handler, options = {}) {
    const route = compile(pattern);
    this.routes.push({ ...route, handler, options });
    return this;
  }

  /** Registers a whole table at once: { 'GET /x': handler | [handler, options] }. */
  mount(table) {
    for (const [pattern, value] of Object.entries(table)) {
      const [handler, options] = Array.isArray(value) ? value : [value, {}];
      this.add(pattern, handler, options);
    }
    return this;
  }

  resolve(method, pathname) {
    const segments = pathname.split('/').filter(Boolean);
    let pathExists = false;
    for (const route of this.routes) {
      const params = match(route, method.toUpperCase(), segments);
      if (params) return { route, params };
      if (route.segments.length === segments.length && match({ ...route, method: method.toUpperCase() }, method.toUpperCase(), segments)) pathExists = true;
    }
    // Distinguish "wrong method" from "unknown path" for clearer client errors.
    const allowed = this.routes
      .filter(route => match({ ...route, method: method.toUpperCase() }, method.toUpperCase(), segments) || match(route, route.method, segments))
      .map(route => route.method);
    if (allowed.length) throw new AppError(405, 'method_not_allowed', `Use ${[...new Set(allowed)].join(', ')} for this path`);
    if (pathExists) throw new AppError(405, 'method_not_allowed', 'Method not allowed');
    throw notFound(`No API route for ${method} ${pathname}`);
  }
}

module.exports = { Router };
