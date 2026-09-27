/* Local persistent store. Uses v2's node:sqlite/WAL approach with people's
 * complete entity schema and service contract. Transactions serialize all access
 * on this connection; unrelated requests cannot join a suspended transaction. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { TABLES, JSON_COLUMNS, assertTable, assertColumn } = require('./schema');
const quote = name => `"${name}"`;

class SqliteStore {
  constructor({ filename }) {
    this.filename = filename;
    this.driver = 'sqlite';
    this.label = 'SQLite (local persistent database)';
    this.scope = new AsyncLocalStorage();
    this.queue = Promise.resolve();
  }
  async init() {
    const { DatabaseSync } = require('node:sqlite');
    if (this.filename !== ':memory:') fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    this.db = new DatabaseSync(this.filename);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    for (const [table, definition] of Object.entries(TABLES)) {
      const columns = Object.entries(definition.columns).map(([name, type]) =>
        `${quote(name)} ${['int', 'bigint'].includes(type) ? 'INTEGER' : 'TEXT'}${name === 'id' ? ' PRIMARY KEY NOT NULL' : ''}`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS ${quote(table)} (${columns.join(',')})`);
      const existing = new Set(this.db.prepare('PRAGMA table_info(' + quote(table) + ')').all().map(column => column.name));
      for (const [name, type] of Object.entries(definition.columns)) {
        if (!existing.has(name)) this.db.exec('ALTER TABLE ' + quote(table) + ' ADD COLUMN ' + quote(name) + ' ' + (['int', 'bigint'].includes(type) ? 'INTEGER' : 'TEXT'));
      }
      for (const column of definition.unique || []) {
        this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${quote(`${table}_${column}_unique`)} ON ${quote(table)} (${quote(column)})`);
      }
    }
    return this;
  }
  access(fn) {
    if (this.scope.getStore()?.active) return Promise.resolve().then(fn);
    const result = this.queue.then(fn);
    this.queue = result.catch(() => {});
    return result;
  }
  async tx(fn) {
    if (this.scope.getStore()?.active) return fn(this);
    return this.access(async () => {
      this.db.exec('BEGIN IMMEDIATE');
      const token = { active: true };
      try {
        const value = await this.scope.run(token, () => fn(this));
        this.db.exec('COMMIT');
        return value;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      } finally { token.active = false; }
    });
  }
  decode(table, row) {
    if (!row) return null;
    const result = { ...row };
    for (const column of JSON_COLUMNS[table]) if (result[column] !== null) result[column] = JSON.parse(result[column]);
    return result;
  }
  encode(table, row) {
    assertTable(table);
    return Object.fromEntries(Object.entries(row).map(([column, value]) => {
      assertColumn(table, column);
      if (value === undefined || value === null) return [column, null];
      return [column, JSON_COLUMNS[table].includes(column) ? JSON.stringify(value) : value];
    }));
  }
  where(table, conditions) {
    const clauses = [], values = [];
    for (const [column, condition] of Object.entries(conditions)) {
      const key = quote(assertColumn(table, column));
      if (condition === null) { clauses.push(`${key} IS NULL`); continue; }
      if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
        for (const [op, value] of Object.entries(condition)) {
          if (op === 'isNull') { clauses.push(`${key} IS ${value ? '' : 'NOT '}NULL`); continue; }
          if (op === 'in' || op === 'notIn') {
            clauses.push(value.length ? `${key} ${op === 'in' ? 'IN' : 'NOT IN'} (${value.map(() => '?').join(',')})` : op === 'in' ? '0' : '1');
            values.push(...value); continue;
          }
          const operator = { ne: 'IS NOT', gt: '>', gte: '>=', lt: '<', lte: '<=' }[op];
          if (!operator) throw new Error(`Unsupported filter operator: ${op}`);
          clauses.push(`${key} ${operator} ?`); values.push(value);
        }
      } else { clauses.push(`${key} = ?`); values.push(condition); }
    }
    return { text: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', values };
  }
  async find(table, conditions = {}, { order = [], limit, offset = 0 } = {}) {
    return this.access(() => {
      assertTable(table);
      const where = this.where(table, conditions);
      let sql = `SELECT * FROM ${quote(table)}${where.text}`;
      if (order.length) sql += ' ORDER BY ' + order.map(([column, dir]) => `${quote(assertColumn(table, column))} ${dir === 'desc' ? 'DESC' : 'ASC'}`).join(',');
      if (limit !== undefined || offset) {
        sql += ' LIMIT ? OFFSET ?'; where.values.push(limit ?? -1, offset);
      }
      return this.db.prepare(sql).all(...where.values).map(row => this.decode(table, row));
    });
  }
  async findOne(table, where = {}, options = {}) { return (await this.find(table, where, { ...options, limit: 1 }))[0] || null; }
  async get(table, id) { return id == null ? null : this.findOne(table, { id }); }
  async count(table, where = {}) { return (await this.find(table, where)).length; }
  async insert(table, row) {
    return this.access(() => {
      const values = this.encode(table, row), columns = Object.keys(values);
      if (!values.id) throw new Error(`${table}.id is required`);
      const result = this.db.prepare(`INSERT INTO ${quote(table)} (${columns.map(quote)}) VALUES (${columns.map(() => '?')}) RETURNING *`).get(...Object.values(values));
      return this.decode(table, result);
    });
  }
  async insertMany(table, rows) { return this.tx(async () => { const out = []; for (const row of rows) out.push(await this.insert(table, row)); return out; }); }
  async update(table, id, patch) {
    return this.access(() => {
      const values = this.encode(table, patch); delete values.id;
      const columns = Object.keys(values);
      if (!columns.length) return this.decode(table, this.db.prepare(`SELECT * FROM ${quote(table)} WHERE id=?`).get(id));
      const row = this.db.prepare(`UPDATE ${quote(table)} SET ${columns.map(c => `${quote(c)}=?`)} WHERE id=? RETURNING *`).get(...Object.values(values), id);
      if (!row) throw new Error(`${table} row not found: ${id}`);
      return this.decode(table, row);
    });
  }
  async remove(table, id) { return this.access(() => !!this.db.prepare(`DELETE FROM ${quote(assertTable(table))} WHERE id=?`).run(id).changes); }
  async nextValue(name) { return this.access(() => this.db.prepare('INSERT INTO counters(id,value) VALUES (?,1) ON CONFLICT(id) DO UPDATE SET value=value+1 RETURNING value').get(name).value); }
  async truncateAll() { return this.tx(async () => { for (const table of Object.keys(TABLES)) this.db.exec(`DELETE FROM ${quote(table)}`); }); }
  async ready() { return this.access(() => !!this.db.prepare('SELECT 1').get()); }
  async migrate({ reset = false } = {}) { if (reset) await this.truncateAll(); return { driver: this.driver, applied: [], note: 'SQLite schema initialized.' }; }
  async close() { return this.access(() => { if (this.db) { this.db.close(); this.db = null; } }); }
}
module.exports = { SqliteStore };
