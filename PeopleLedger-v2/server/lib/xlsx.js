/* Read-only .xlsx (Office Open XML SpreadsheetML) reader.
 *
 * Written here rather than added as a dependency for the same reason as lib/zip.js:
 * an import path that decides whether money is accepted must be reviewable
 * alongside the rules that judge it. Nothing is executed from the workbook — the
 * archive is inflated, the XML is read for values only, and formulas, errors and
 * external references are refused rather than evaluated.
 *
 * The output is a plain string grid handed to csv.toObjects, so a workbook and a
 * CSV are validated by exactly the same code path: identical header rules,
 * identical column-count rules, identical `__line` numbering and identical error
 * messages. payroll, payment and bank imports therefore accept both containers on
 * the same terms.
 *
 * Deliberate limits: no macros, no encrypted or ZIP64 archives, bounded entry
 * count, bounded inflated size, bounded rows and columns. Cells that a
 * spreadsheet would show as a date are emitted as ISO-8601 text so the downstream
 * validators see the same grammar they see in a CSV. */
'use strict';
const zlib = require('node:zlib');
const { badRequest, tooLarge } = require('./errors');

const MAX_BYTES = 5 * 1024 * 1024;        // compressed workbook
const MAX_INFLATED_BYTES = 20 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const MAX_ROWS = 1001;                    // header + 1000 data rows
const MAX_COLUMNS = 40;

// Built-in number formats that a spreadsheet renders as a date or a date-time.
const BUILT_IN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

// ---------------------------------------------------------------------------
// ZIP reading (central directory, so archives written with data descriptors and
// streaming writers are read correctly)
// ---------------------------------------------------------------------------

function findEndOfCentralDirectory(buffer) {
  const floor = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= floor; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

/** @returns {Map<string, Buffer>} entry name -> inflated bytes */
function readArchive(buffer) {
  if (!Buffer.isBuffer(buffer)) throw badRequest('A workbook must be supplied as bytes');
  if (!buffer.length) throw badRequest('The workbook file is empty');
  if (buffer.length > MAX_BYTES) throw tooLarge('Workbooks must not exceed 5 MB');
  if (buffer.readUInt32LE(0) !== 0x04034b50) throw badRequest('Not a readable .xlsx workbook (missing ZIP signature). Use .xlsx or UTF-8 CSV.');

  const end = findEndOfCentralDirectory(buffer);
  if (end < 0) throw badRequest('The workbook archive is damaged (no ZIP directory found)');
  const count = buffer.readUInt16LE(end + 10);
  let position = buffer.readUInt32LE(end + 16);
  if (!count || count > MAX_ENTRIES) throw badRequest('Unsupported workbook: unexpected number of archive entries');
  if (position >= buffer.length) throw badRequest('The workbook archive directory is out of range');

  const entries = new Map();
  let inflatedTotal = 0;
  for (let i = 0; i < count; i++) {
    if (position + 46 > buffer.length || buffer.readUInt32LE(position) !== 0x02014b50) {
      throw badRequest('The workbook archive directory is damaged');
    }
    const flags = buffer.readUInt16LE(position + 8);
    const method = buffer.readUInt16LE(position + 10);
    const compressedSize = buffer.readUInt32LE(position + 20);
    const uncompressedSize = buffer.readUInt32LE(position + 24);
    const nameLength = buffer.readUInt16LE(position + 28);
    const extraLength = buffer.readUInt16LE(position + 30);
    const commentLength = buffer.readUInt16LE(position + 32);
    const localOffset = buffer.readUInt32LE(position + 42);

    if (flags & 0x0001) throw badRequest('Encrypted workbooks are not supported. Remove the password and export again.');
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw badRequest('ZIP64 workbooks are not supported');
    }
    if (method !== 0 && method !== 8) throw badRequest('Unsupported compression inside the workbook archive');

    inflatedTotal += uncompressedSize;
    if (inflatedTotal > MAX_INFLATED_BYTES) throw tooLarge('The workbook expands to more than 20 MB');

    const name = buffer.subarray(position + 46, position + 46 + nameLength).toString('utf8');
    // Only the parts actually needed are inflated; anything else (images, macros,
    // printer settings) is skipped entirely.
    if (isNeeded(name)) {
      if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
        throw badRequest(`The workbook entry ${name} is damaged`);
      }
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const body = buffer.subarray(dataStart, dataStart + compressedSize);
      let data;
      try { data = method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body); } catch {
        throw badRequest(`The workbook entry ${name} could not be decompressed`);
      }
      entries.set(name, data);
    }
    position += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

const isNeeded = name => name === '[Content_Types].xml'
  || name === 'xl/workbook.xml'
  || name === 'xl/_rels/workbook.xml.rels'
  || name === 'xl/sharedStrings.xml'
  || name === 'xl/styles.xml'
  || /^xl\/worksheets\/[^/]+\.xml$/.test(name);

// ---------------------------------------------------------------------------
// Minimal XML value reading. No DTD, no entity expansion beyond the five
// predefined entities and numeric character references, so an external-entity or
// billion-laughs payload has nothing to act on.
// ---------------------------------------------------------------------------

function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (match, body) => {
    if (body === 'amp') return '&';
    if (body === 'lt') return '<';
    if (body === 'gt') return '>';
    if (body === 'quot') return '"';
    if (body === 'apos') return "'";
    const code = body[1] === 'x' || body[1] === 'X'
      ? Number.parseInt(body.slice(2), 16)
      : Number.parseInt(body.slice(1), 10);
    return Number.isInteger(code) && code >= 0x20 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
  });
}

/** XML permits either quote character around an attribute value; accept both. */
const attribute = (tag, name) => {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  if (!match) return null;
  return decodeEntities(match[1] !== undefined ? match[1] : match[2]);
};

/** Concatenated text of every <t> element inside a fragment. */
function textOf(fragment) {
  let out = '';
  for (const match of fragment.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)) {
    out += decodeEntities(match[1] ?? '');
  }
  return out;
}

function readSharedStrings(xml) {
  if (!xml) return [];
  const list = [];
  for (const match of xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>|<si(?:\s[^>]*)?\/>/g)) {
    list.push(textOf(match[1] ?? ''));
  }
  return list;
}

/** cellXfs index -> true when the style renders the value as a date. */
function readDateStyles(xml) {
  if (!xml) return [];
  const custom = new Map();
  for (const match of xml.matchAll(/<numFmt\s[^>]*\/>/g)) {
    const id = Number(attribute(match[0], 'numFmtId'));
    const code = attribute(match[0], 'formatCode') || '';
    // A date format contains y/m/d/h tokens outside quoted literals; a currency or
    // plain numeric format does not.
    const bare = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '');
    if (Number.isInteger(id)) custom.set(id, /(^|[^\\])[yYdDhHsS]/.test(bare) || /m{3,}/.test(bare) || /[yY]{2}/.test(bare));
  }
  const cellXfsBlock = /<cellXfs[\s\S]*?<\/cellXfs>/.exec(xml);
  if (!cellXfsBlock) return [];
  const flags = [];
  for (const match of cellXfsBlock[0].matchAll(/<xf\s[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g)) {
    const id = Number(attribute(match[0], 'numFmtId') ?? '0');
    flags.push(BUILT_IN_DATE_FORMATS.has(id) || custom.get(id) === true);
  }
  return flags;
}

function readWorkbook(entries) {
  const workbookXml = entries.get('xl/workbook.xml');
  if (!workbookXml) throw badRequest('The workbook is missing its xl/workbook.xml part');
  const relsXml = entries.get('xl/_rels/workbook.xml.rels')?.toString('utf8') || '';
  const targets = new Map();
  for (const match of relsXml.matchAll(/<Relationship\s[^>]*\/>/g)) {
    const id = attribute(match[0], 'Id');
    const target = attribute(match[0], 'Target');
    if (id && target) targets.set(id, target.replace(/^\/?xl\//, '').replace(/^\.\//, ''));
  }

  const xml = workbookXml.toString('utf8');
  const sheets = [];
  const block = /<sheets[\s\S]*?<\/sheets>/.exec(xml);
  for (const match of (block ? block[0] : '').matchAll(/<sheet\s[^>]*\/>/g)) {
    const name = attribute(match[0], 'name');
    const relationId = attribute(match[0], 'r:id') || attribute(match[0], 'id');
    const state = attribute(match[0], 'state');
    const target = relationId ? targets.get(relationId) : null;
    const part = target ? `xl/${target}` : null;
    if (!name) continue;
    sheets.push({ name, part: part && entries.has(part) ? part : null, hidden: state === 'hidden' || state === 'veryHidden' });
  }
  if (!sheets.length) throw badRequest('The workbook declares no worksheets');
  return sheets;
}

const columnIndex = reference => {
  const letters = /^([A-Z]+)/.exec(String(reference || '').toUpperCase());
  if (!letters) return -1;
  let index = 0;
  for (const character of letters[1]) index = index * 26 + (character.charCodeAt(0) - 64);
  return index - 1;
};

/** Excel serial number -> ISO date or date-time. The 1899-12-30 epoch already
 *  absorbs the Lotus 1-2-3 leap-year defect for every date after 1900-03-01. */
function serialToIso(serial, use1904) {
  const epoch = use1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const millis = Math.round(epoch + serial * 86400000);
  const date = new Date(millis);
  if (!Number.isFinite(date.getTime())) return String(serial);
  const iso = date.toISOString();
  const hasTime = Math.abs(serial - Math.floor(serial)) > 1e-9;
  return hasTime ? iso : iso.slice(0, 10);
}

function readSheetGrid(xml, { sharedStrings, dateStyles, use1904, worksheetName }) {
  const rows = new Map();
  let widest = 0;

  // The self-closing alternative is tried first so an empty <row/> or <c/> can
  // never be mistaken for an opening tag and swallow the rows that follow it.
  for (const rowMatch of xml.matchAll(/<row(?:\s[^>]*?)?\/>|<row(?:\s[^>]*?)?>([\s\S]*?)<\/row>/g)) {
    const openTag = /^<row[^>]*>/.exec(rowMatch[0])[0];
    const rowNumber = Number(attribute(openTag, 'r') ?? (rows.size + 1));
    if (!Number.isInteger(rowNumber) || rowNumber < 1) continue;
    if (rowNumber > MAX_ROWS) throw badRequest(`Worksheet "${worksheetName}" exceeds the limit of ${MAX_ROWS - 1} data rows`);
    const cells = [];

    for (const cellMatch of (rowMatch[1] ?? '').matchAll(/<c(?:\s[^>]*?)?\/>|<c(?:\s[^>]*?)?>([\s\S]*?)<\/c>/g)) {
      const tag = /^<c[^>]*>/.exec(cellMatch[0])[0];
      const body = cellMatch[1] ?? '';
      const reference = attribute(tag, 'r');
      const index = reference ? columnIndex(reference) : cells.length;
      if (index < 0) continue;
      if (index >= MAX_COLUMNS) throw badRequest(`Worksheet "${worksheetName}" exceeds the limit of ${MAX_COLUMNS} columns`);

      if (/<f(\s|\/|>)/.test(body)) {
        throw badRequest(`Cell ${reference || '?'} in "${worksheetName}" contains a formula. Convert formulas to values before importing.`);
      }
      const type = attribute(tag, 't') || 'n';
      if (type === 'e') {
        throw badRequest(`Cell ${reference || '?'} in "${worksheetName}" contains an error value. Correct it before importing.`);
      }

      let value = '';
      if (type === 's') {
        const raw = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body);
        const position = raw ? Number(decodeEntities(raw[1])) : NaN;
        value = Number.isInteger(position) && position >= 0 && position < sharedStrings.length ? sharedStrings[position] : '';
      } else if (type === 'inlineStr') {
        value = textOf(body);
      } else if (type === 'str') {
        const raw = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body);
        value = raw ? decodeEntities(raw[1]) : '';
      } else if (type === 'b') {
        const raw = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body);
        value = raw && decodeEntities(raw[1]).trim() === '1' ? 'TRUE' : 'FALSE';
      } else {
        const raw = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body);
        const text = raw ? decodeEntities(raw[1]).trim() : '';
        const styleIndex = Number(attribute(tag, 's') ?? '0');
        const numeric = Number(text);
        value = text !== '' && Number.isFinite(numeric) && dateStyles[styleIndex]
          ? serialToIso(numeric, use1904)
          : text;
      }

      while (cells.length < index) cells.push('');
      cells[index] = String(value ?? '').trim();
    }
    widest = Math.max(widest, cells.length);
    rows.set(rowNumber, cells);
  }

  const highest = rows.size ? Math.max(...rows.keys()) : 0;
  const grid = [];
  for (let n = 1; n <= highest; n++) {
    const cells = rows.get(n) || [];
    while (cells.length < widest) cells.push('');
    grid.push(cells);
  }
  // Blank rows carry no record, exactly as in the CSV reader.
  const populated = grid.filter(cells => cells.some(value => value !== ''));
  // Spreadsheets routinely record empty trailing cells. Dropping wholly empty
  // trailing columns keeps the column count equal to what the sheet displays, so
  // the shared header check reports real mismatches rather than formatting noise.
  let width = widest;
  while (width > 0 && populated.every(cells => (cells[width - 1] ?? '') === '')) width--;
  return populated.map(cells => cells.slice(0, width));
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/** Cheap container probe so callers can choose a reader without try/catch. */
function isWorkbook(input) {
  return Buffer.isBuffer(input) && input.length > 4 && input.readUInt32LE(0) === 0x04034b50;
}

/**
 * Reads one worksheet into a string grid.
 * @param {Buffer} input
 * @param {{sheet?:string}} options worksheet name; the first non-empty sheet by default
 * @returns {{worksheet:string, worksheets:string[], rows:string[][]}}
 */
function parseRows(input, { sheet = null } = {}) {
  const entries = readArchive(input);
  const declared = readWorkbook(entries);
  const sharedStrings = readSharedStrings(entries.get('xl/sharedStrings.xml')?.toString('utf8'));
  const stylesXml = entries.get('xl/styles.xml')?.toString('utf8');
  const dateStyles = readDateStyles(stylesXml);
  const use1904 = /date1904\s*=\s*["'](1|true)["']/i.test(entries.get('xl/workbook.xml').toString('utf8'));
  const worksheets = declared.map(entry => entry.name);

  let chosen;
  if (sheet !== null && sheet !== undefined && sheet !== '') {
    chosen = declared.find(entry => entry.name === sheet);
    if (!chosen) throw badRequest(`Worksheet not found: ${sheet}`, { worksheets });
  } else {
    chosen = declared.find(entry => entry.part && !entry.hidden) || declared.find(entry => entry.part);
  }
  if (!chosen || !chosen.part) throw badRequest('The workbook contains no readable worksheet', { worksheets });

  const rows = readSheetGrid(entries.get(chosen.part).toString('utf8'), {
    sharedStrings, dateStyles, use1904, worksheetName: chosen.name
  });
  return { worksheet: chosen.name, worksheets, rows };
}

/** Worksheet names, for the sheet-selection step of an import. */
function worksheets(input) {
  const entries = readArchive(input);
  return readWorkbook(entries).map(entry => ({ name: entry.name, readable: !!entry.part, hidden: entry.hidden }));
}

/**
 * Parses into objects keyed by the declared headers, identical in shape and in
 * error wording to csv.parse.
 * @returns {Array<object>} objects carrying the source line number as __line
 */
function parse(input, headers, { maxRows = 1000, sheet = null } = {}) {
  const { rows } = parseRows(input, { sheet });
  return csvToObjects(rows, headers, { maxRows, label: 'Worksheet' });
}

/**
 * Worksheet selection plus a bounded look at the content, before any validation.
 * Used by the preview step so a preparer can choose the right sheet.
 */
function describe(input, { sheet = null, limit = 10 } = {}) {
  const sheets = worksheets(input);
  const readable = sheets.filter(entry => entry.readable);
  const needsWorksheetChoice = !sheet && readable.length > 1;
  const { worksheet, rows } = parseRows(input, { sheet });
  return {
    worksheet,
    worksheets: sheets.map(entry => entry.name),
    readableWorksheets: readable.map(entry => entry.name),
    needsWorksheetChoice,
    headers: rows[0] || [],
    rowCount: Math.max(0, rows.length - 1),
    sample: rows.slice(1, 1 + Math.max(0, limit)),
    note: needsWorksheetChoice
      ? `The workbook has ${readable.length} worksheets with content. "${worksheet}" was read; name another worksheet to switch.`
      : `Worksheet "${worksheet}" was read.`
  };
}

// Required lazily: csv.js and xlsx.js are peers and must not form a load cycle.
function csvToObjects(rows, headers, options) {
  return require('./csv').toObjects(rows, headers, options);
}

module.exports = {
  parse, parseRows, worksheets, describe, isWorkbook,
  MAX_BYTES, MAX_INFLATED_BYTES, MAX_ROWS, MAX_COLUMNS
};
