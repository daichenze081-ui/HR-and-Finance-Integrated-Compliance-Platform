/* In-process store implementing the same contract as the PostgreSQL adapter.
 *
 * It exists for two reasons: the automated suite must run without a database
 * installed, and a reviewer without PostgreSQL can still exercise the whole
 * workflow. It is explicitly labelled everywhere it is used and it does not
 * persist across restarts, so it must never be presented as the production
 * persistence path. */
'use strict';
const { assertTable, assertColumn, JSON_COLUMNS, columnsOf } = require('./schema');

const clone = value => (value === undefined || value === null ? value : JSON.parse(JSON.stringify(value)));

function matchesCondition(actual, condition) {
  if (condition === null) return actual === null || actual === undefined;
  if (condition !== undefined && condition !== null && typeof condition === 'object' && !Array.isArray(condition)) {
    for (const [operator, operand] of Object.entries(condition)) {
      switch (operator) {
        case 'in': if (!operand.includes(actual)) return false; break;
        case 'notIn': if (operand.includes(actual)) return false; break;
        case 'ne': if (actual === operand) return false; break;
        case 'gt': if (!(actual > operand)) return false; break;
        case 'gte': if (!(actual >= operand)) return false; break;
        case 'lt': if (!(actual < operand)) return false; break;
        case 'lte': if (!(actual <= operand)) return false; break;
        case 'isNull':
          if (operand === true && !(actual === null || actual === undefined)) return false;
          if (operand === false && (actual === null || actual === undefined)) return false;
          break;
        default: throw new Error(`Unsupported filter operator: ${operator}`);
      }
    }
    return true;
  }
  return actual === condition;
}

function matches(row, where) {
  for (const [column, condition] of Object.entries(where || {})) {
    if (!matchesCondition(row[column], condition)) return false;
  }
  return true;
}

function compare(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  return a < b ? -1 : 1;
}

function sortRows(rows, order) {
  if (!order || !order.length) return rows;
  return rows.sort((left, right) => {
    for (const [column, direction] of order) {
      const result = compare(left[column], right[column]);
      if (result !== 0) return direction === 'desc' ? -result : result;
    }
    return 0;
  });
}

class MemoryStore {
  constructor() {
    this.driver = 'memory';
    this.label = 'in-process store (not persisted)';
    this.tables = new Map();
    this.depth = 0;
  }

  async init() { return this; }
  async close() { this.tables.clear(); }
  async ready() { return true; }

  table(name) {
    assertTable(name);
    if (!this.tables.has(name)) this.tables.set(name, new Map());
    return this.tables.get(name);
  }

  snapshot() {
    return new Map([...this.tables].map(([name, rows]) => [name, new Map([...rows].map(([id, row]) => [id, clone(row)]))]));
  }

  /** Snapshot/rollback transaction. Single-process only, but genuinely atomic:
   *  a failed multi-row write leaves no partial state behind. */
  async tx(fn) {
    if (this.depth > 0) return fn(this); // joins the outer transaction
    const before = this.snapshot();
    this.depth++;
    try {
      const result = await fn(this);
      this.depth--;
      return result;
    } catch (error) {
      this.tables = before;
      this.depth--;
      throw error;
    }
  }

  normalise(table, row) {
    const allowed = columnsOf(table);
    const out = {};
    for (const column of allowed) out[column] = row[column] === undefined ? null : row[column];
    const unknown = Object.keys(row).filter(k => !allowed.includes(k));
    if (unknown.length) throw new Error(`Unknown column${unknown.length === 1 ? '' : 's'} for ${table}: ${unknown.join(', ')}`);
    for (const column of JSON_COLUMNS[table]) out[column] = clone(out[column]);
    return out;
  }

  async insert(table, row) {
    const record = this.normalise(assertTable(table), row);
    if (!record.id) throw new Error(`${table}.id is required`);
    const rows = this.table(table);
    if (rows.has(record.id)) throw new Error(`Duplicate primary key in ${table}: ${record.id}`);
    rows.set(record.id, record);
    return clone(record);
  }

  async insertMany(table, list) {
    const out = [];
    for (const row of list) out.push(await this.insert(table, row));
    return out;
  }

  async get(table, id) {
    if (id === undefined || id === null) return null;
    return clone(this.table(assertTable(table)).get(id) || null);
  }

  async find(table, where = {}, { order, limit, offset = 0 } = {}) {
    Object.keys(where).forEach(column => assertColumn(table, column));
    let rows = [...this.table(assertTable(table)).values()].filter(row => matches(row, where));
    rows = sortRows(rows, order);
    if (offset) rows = rows.slice(offset);
    if (limit !== undefined) rows = rows.slice(0, limit);
    return rows.map(clone);
  }

  async findOne(table, where = {}, options = {}) {
    const rows = await this.find(table, where, { ...options, limit: 1 });
    return rows[0] || null;
  }

  async count(table, where = {}) {
    return (await this.find(table, where)).length;
  }

  async update(table, id, patch) {
    const rows = this.table(assertTable(table));
    const current = rows.get(id);
    if (!current) throw new Error(`${table} row not found: ${id}`);
    const allowed = columnsOf(table);
    for (const column of Object.keys(patch)) {
      if (!allowed.includes(column)) throw new Error(`Unknown column ${table}.${column}`);
    }
    const next = { ...current, ...clone(patch), id: current.id };
    rows.set(id, next);
    return clone(next);
  }

  async remove(table, id) {
    return this.table(assertTable(table)).delete(id);
  }

  /** Atomic counter used for report versions and human-readable sequences. */
  async nextValue(name) {
    const rows = this.table('counters');
    const current = rows.get(name);
    const value = (current ? current.value : 0) + 1;
    rows.set(name, { id: name, value });
    return value;
  }

  async migrate() { return { driver: 'memory', applied: [], note: 'Schema is created implicitly by the in-process store.' }; }

  async truncateAll() { this.tables.clear(); }
}

module.exports = { MemoryStore };
