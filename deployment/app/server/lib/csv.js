/* Generic CSV reader/writer using the same grammar as dist/demo/core.js: RFC4180
 * quoting, BOM tolerance, CRLF or LF rows, and a size ceiling. Payroll imports
 * keep using core.parseCSV; this handles the payment ledger and export files. */
'use strict';
const { badRequest, tooLarge } = require('../lib/errors');

const MAX_BYTES = 1024 * 1024;

function parseRows(input) {
  if (typeof input !== 'string') throw badRequest('CSV content must be text');
  if (Buffer.byteLength(input, 'utf8') > MAX_BYTES) throw tooLarge('CSV files must not exceed 1 MB');
  const src = input.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let closed = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; }
      } else cell += ch;
      continue;
    }
    if (ch === '"') {
      if (cell !== '' || closed) throw badRequest('Invalid CSV quoting');
      quoted = true;
      continue;
    }
    if (ch === ',' || ch === '\n' || ch === '\r') {
      row.push(cell); cell = ''; closed = false;
      if (ch !== ',') {
        if (ch === '\r' && src[i + 1] === '\n') i++;
        rows.push(row); row = [];
      }
      continue;
    }
    if (closed) throw badRequest('A CSV closing quote must be followed by a separator');
    cell += ch;
  }
  if (quoted) throw badRequest('Unclosed CSV quote');
  if (cell !== '' || row.length || closed) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(value => value !== ''));
}

/**
 * Header check and row-to-object conversion. This is the single validation path
 * shared by the CSV reader and the workbook reader in lib/xlsx.js, so a payroll,
 * payment or bank file is accepted on identical terms whatever its container.
 *
 * @param {string[][]} grid  row 1 is the header row
 * @param {string[]} headers required header names, in any order
 * @param {{maxRows?:number, label?:string}} options
 * @returns {Array<object>} objects carrying the source line number as __line
 */
function toObjects(grid, headers, { maxRows = 1000, label = 'CSV' } = {}) {
  const rows = grid.slice();
  if (rows.length < 2) throw badRequest(`${label} must contain a header row and at least one record`);
  const head = rows.shift().map(value => String(value ?? '').trim());
  const missing = headers.filter(h => !head.includes(h));
  if (missing.length) throw badRequest(`${label} headers must include: ${headers.join(', ')} (missing ${missing.join(', ')})`);
  if (head.length !== headers.length) throw badRequest(`${label} must contain exactly these columns: ${headers.join(', ')}`);
  if (new Set(head).size !== head.length) throw badRequest(`${label} contains a repeated column name`);
  if (rows.length > maxRows) throw badRequest(`Import at most ${maxRows} rows per file`);
  return rows.map((values, index) => {
    if (values.length !== head.length) throw badRequest(`Incorrect column count in ${label} row ${index + 2}`);
    return { __line: index + 2, ...Object.fromEntries(head.map((key, i) => [key, values[i]])) };
  });
}

/**
 * Parses into objects keyed by the declared headers.
 * @param {string} input
 * @param {string[]} headers required header names, in any order
 * @param {{maxRows?:number}} options
 */
function parse(input, headers, { maxRows = 1000 } = {}) {
  return toObjects(parseRows(input), headers, { maxRows, label: 'CSV' });
}

const decodeUtf8 = buffer => {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch {
    throw badRequest('The uploaded file is not valid UTF-8 text. Export it as UTF-8 CSV or as .xlsx.');
  }
};

/**
 * One import entry point for both containers. A caller supplies CSV text or file
 * bytes; a workbook is recognised by its signature and read through lib/xlsx,
 * everything else is read as UTF-8 CSV. Both routes end in toObjects, so payroll,
 * payment and bank imports share one set of header and column rules.
 *
 * @param {{text?:string, buffer?:Buffer, worksheet?:string|null}} source
 * @param {string[]} headers
 * @param {{maxRows?:number}} options
 * @returns {{format:'csv'|'xlsx', worksheet:string|null, worksheets:string[], rows:Array<object>}}
 */
function readTable(source, headers, { maxRows = 1000 } = {}) {
  const worksheet = source && source.worksheet ? source.worksheet : null;
  if (source && Buffer.isBuffer(source.buffer)) {
    const xlsx = require('./xlsx'); // lazy: csv.js and xlsx.js are peers
    if (xlsx.isWorkbook(source.buffer)) {
      const read = xlsx.parseRows(source.buffer, { sheet: worksheet });
      return {
        format: 'xlsx',
        worksheet: read.worksheet,
        worksheets: read.worksheets,
        rows: toObjects(read.rows, headers, { maxRows, label: 'Worksheet' })
      };
    }
    return { format: 'csv', worksheet: null, worksheets: [], rows: parse(decodeUtf8(source.buffer), headers, { maxRows }) };
  }
  if (source && typeof source.text === 'string') {
    return { format: 'csv', worksheet: null, worksheets: [], rows: parse(source.text, headers, { maxRows }) };
  }
  throw badRequest('Provide CSV text or workbook bytes');
}

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * Normalises an import request body into a readTable source plus the canonical
 * bytes used for the content digest. Every dataset import accepts the same two
 * shapes, so a preparer can supply a CSV or a workbook anywhere.
 *
 * @param {{csv?:string, workbookBase64?:string, worksheet?:string}} body
 */
function requestSource(body) {
  if (body && typeof body.workbookBase64 === 'string' && body.workbookBase64.trim()) {
    const buffer = Buffer.from(body.workbookBase64, 'base64');
    if (!buffer.length) throw badRequest('workbookBase64 did not decode to any bytes');
    if (buffer.length > MAX_UPLOAD_BYTES) throw tooLarge('Import files must not exceed 5 MB');
    return { buffer, bytes: buffer, worksheet: body.worksheet || null };
  }
  if (body && typeof body.csv === 'string' && body.csv.trim()) {
    return { text: body.csv, bytes: Buffer.from(body.csv, 'utf8'), worksheet: null };
  }
  throw badRequest('Provide the file as csv text or as workbookBase64');
}

/** Spreadsheet-safe writer: formula-leading cells are prefixed, matching core.toCSV. */
function write(headers, rows) {
  const quote = value => {
    let text = String(value ?? '');
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const body = rows.map(row => headers.map(key => quote(row[key])));
  return `\uFEFF${[headers.map(quote), ...body].map(cells => cells.join(',')).join('\r\n')}`;
}

module.exports = {
  parse, parseRows, toObjects, readTable, requestSource, decodeUtf8, write,
  MAX_BYTES, MAX_UPLOAD_BYTES
};
