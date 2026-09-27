/* PostgreSQL adapter. All SQL is parameterised; table and column names are
 * validated against the schema description before they can reach a statement,
 * so no caller-supplied string is ever interpolated into SQL text. */
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { assertTable, assertColumn, JSON_COLUMNS, columnsOf } = require('./schema');

function loadPg() {
  try { return require('pg'); } catch {
    throw new Error('The "pg" package is not installed. Run "npm install", or set DB_DRIVER=memory to run without PostgreSQL.');
  }
}

const quote = identifier => `"${identifier.replace(/"/g, '""')}"`;

function buildWhere(table, where, startIndex = 1) {
  const clauses = [];
  const values = [];
  let index = startIndex;
  for (const [rawColumn, condition] of Object.entries(where || {})) {
    const column = quote(assertColumn(table, rawColumn));
    if (condition === null) { clauses.push(`${column} IS NULL`); continue; }
    if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
      for (const [operator, operand] of Object.entries(condition)) {
        switch (operator) {
          case 'in':
            if (!operand.length) { clauses.push('FALSE'); break; }
            clauses.push(`${column} = ANY($${index++})`); values.push(operand); break;
          case 'notIn':
            if (!operand.length) break;
            clauses.push(`NOT (${column} = ANY($${index++}))`); values.push(operand); break;
          case 'ne': clauses.push(`(${column} IS DISTINCT FROM $${index++})`); values.push(operand); break;
          case 'gt': clauses.push(`${column} > $${index++}`); values.push(operand); break;
          case 'gte': clauses.push(`${column} >= $${index++}`); values.push(operand); break;
          case 'lt': clauses.push(`${column} < $${index++}`); values.push(operand); break;
          case 'lte': clauses.push(`${column} <= $${index++}`); values.push(operand); break;
          case 'isNull': clauses.push(operand === true ? `${column} IS NULL` : `${column} IS NOT NULL`); break;
          default: throw new Error(`Unsupported filter operator: ${operator}`);
        }
      }
      continue;
    }
    clauses.push(`${column} = $${index++}`);
    values.push(condition);
  }
  return { text: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', values, nextIndex: index };
}

function buildOrder(table, order) {
  if (!order || !order.length) return '';
  const parts = order.map(([column, direction = 'asc']) => {
    const dir = String(direction).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    return `${quote(assertColumn(table, column))} ${dir}`;
  });
  return ` ORDER BY ${parts.join(', ')}`;
}

function encode(table, row) {
  const allowed = columnsOf(table);
  const unknown = Object.keys(row).filter(k => !allowed.includes(k));
  if (unknown.length) throw new Error(`Unknown column${unknown.length === 1 ? '' : 's'} for ${table}: ${unknown.join(', ')}`);
  const out = {};
  for (const column of Object.keys(row)) {
    const value = row[column];
    out[column] = JSON_COLUMNS[table].includes(column) && value !== null && value !== undefined
      ? JSON.stringify(value)
      : (value === undefined ? null : value);
  }
  return out;
}

class PgStore {
  constructor(config, client = null) {
    this.driver = 'postgres';
    this.label = 'PostgreSQL';
    this.config = config;
    this.client = client;   // set when this instance represents a transaction
    this.pool = null;
  }

  async init() {
    const pg = loadPg();
    // BIGINT arrives as a string by default; money must stay an exact integer.
    pg.types.setTypeParser(20, value => {
      const n = Number(value);
      if (!Number.isSafeInteger(n)) throw new Error('Stored amount exceeds the safe integer range');
      return n;
    });
    this.pool = new pg.Pool({
      connectionString: this.config.url,
      ssl: this.config.ssl ? { rejectUnauthorized: true } : undefined,
      max: 8,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 8000
    });
    this.pool.on('error', () => {}); // handled per query
    await this.query('SELECT 1');
    return this;
  }

  async close() { if (this.pool) await this.pool.end(); }
  async ready() { await this.query('SELECT 1'); return true; }

  async query(text, values = []) {
    const runner = this.client || this.pool;
    if (!runner) throw new Error('Database is not initialised');
    return runner.query(text, values);
  }

  async tx(fn) {
    if (this.client) return fn(this); // already inside a transaction
    const client = await this.pool.connect();
    const scoped = new PgStore(this.config, client);
    scoped.pool = this.pool;
    try {
      await client.query('BEGIN');
      const result = await fn(scoped);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* connection already broken */ }
      throw error;
    } finally {
      client.release();
    }
  }

  async insert(table, row) {
    assertTable(table);
    const encoded = encode(table, row);
    const columns = Object.keys(encoded);
    if (!columns.includes('id') || !encoded.id) throw new Error(`${table}.id is required`);
    const placeholders = columns.map((_, i) => `$${i + 1}`);
    const sql = `INSERT INTO ${quote(table)} (${columns.map(quote).join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`;
    const { rows } = await this.query(sql, columns.map(c => encoded[c]));
    return rows[0];
  }

  async insertMany(table, list) {
    const out = [];
    for (const row of list) out.push(await this.insert(table, row));
    return out;
  }

  async get(table, id) {
    if (id === undefined || id === null) return null;
    const { rows } = await this.query(`SELECT * FROM ${quote(assertTable(table))} WHERE "id" = $1`, [id]);
    return rows[0] || null;
  }

  async find(table, where = {}, { order, limit, offset } = {}) {
    assertTable(table);
    const clause = buildWhere(table, where);
    let sql = `SELECT * FROM ${quote(table)}${clause.text}${buildOrder(table, order)}`;
    const values = [...clause.values];
    let index = clause.nextIndex;
    if (limit !== undefined) { sql += ` LIMIT $${index++}`; values.push(limit); }
    if (offset) { sql += ` OFFSET $${index++}`; values.push(offset); }
    const { rows } = await this.query(sql, values);
    return rows;
  }

  async findOne(table, where = {}, options = {}) {
    const rows = await this.find(table, where, { ...options, limit: 1 });
    return rows[0] || null;
  }

  async count(table, where = {}) {
    const clause = buildWhere(assertTable(table), where);
    const { rows } = await this.query(`SELECT COUNT(*)::bigint AS n FROM ${quote(table)}${clause.text}`, clause.values);
    return Number(rows[0].n);
  }

  async update(table, id, patch) {
    assertTable(table);
    const encoded = encode(table, patch);
    const columns = Object.keys(encoded).filter(c => c !== 'id');
    if (!columns.length) return this.get(table, id);
    const sets = columns.map((c, i) => `${quote(c)} = $${i + 2}`);
    const sql = `UPDATE ${quote(table)} SET ${sets.join(', ')} WHERE "id" = $1 RETURNING *`;
    const { rows } = await this.query(sql, [id, ...columns.map(c => encoded[c])]);
    if (!rows[0]) throw new Error(`${table} row not found: ${id}`);
    return rows[0];
  }

  async remove(table, id) {
    const { rowCount } = await this.query(`DELETE FROM ${quote(assertTable(table))} WHERE "id" = $1`, [id]);
    return rowCount > 0;
  }

  async nextValue(name) {
    const { rows } = await this.query(
      `INSERT INTO "counters" ("id", "value") VALUES ($1, 1)
       ON CONFLICT ("id") DO UPDATE SET "value" = "counters"."value" + 1
       RETURNING "value"`, [name]
    );
    return Number(rows[0].value);
  }

  async migrate({ reset = false } = {}) {
    await this.query(`CREATE TABLE IF NOT EXISTS "schema_migrations" (
      "name" text PRIMARY KEY, "applied_at" timestamptz NOT NULL DEFAULT now(), "checksum" text NOT NULL)`);
    if (reset) {
      await this.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      await this.query(`CREATE TABLE IF NOT EXISTS "schema_migrations" (
        "name" text PRIMARY KEY, "applied_at" timestamptz NOT NULL DEFAULT now(), "checksum" text NOT NULL)`);
    }
    const dir = this.config.migrationsDir;
    const files = (await fs.readdir(dir)).filter(f => f.endsWith('.sql')).sort();
    const { rows: done } = await this.query('SELECT "name" FROM "schema_migrations"');
    const already = new Set(done.map(r => r.name));
    const applied = [];
    for (const file of files) {
      if (already.has(file)) continue;
      const sql = await fs.readFile(path.join(dir, file), 'utf8');
      const checksum = require('../../lib/hash').sha256(sql);
      await this.tx(async scoped => {
        await scoped.query(sql);
        await scoped.query('INSERT INTO "schema_migrations" ("name", "checksum") VALUES ($1, $2)', [file, checksum]);
      });
      applied.push(file);
    }
    return { driver: 'postgres', applied, alreadyApplied: [...already] };
  }
}

module.exports = { PgStore };
