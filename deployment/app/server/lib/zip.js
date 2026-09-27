/* Minimal ZIP writer (store and deflate), built on node:zlib.
 *
 * Written here rather than added as a dependency because an evidence package must
 * be produced by code that can be reviewed alongside the manifest it describes. */
'use strict';
const zlib = require('node:zlib');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

/** DOS date/time fields, clamped to the earliest value the format can express. */
function dosStamp(date) {
  const year = Math.max(1980, date.getUTCFullYear());
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate()
  };
}

const sanitize = name => String(name)
  .replace(/\\/g, '/')
  .split('/')
  .filter(part => part && part !== '.' && part !== '..')
  .join('/');

/**
 * @param {Array<{name:string, data:Buffer|string, store?:boolean, at?:Date}>} entries
 * @returns {Buffer} a complete ZIP archive
 */
function create(entries, { at = new Date() } = {}) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = sanitize(entry.name);
    if (!name) throw new Error('ZIP entry names must not be empty');
    const nameBuffer = Buffer.from(name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ''), 'utf8');
    const deflate = entry.store !== true && raw.length > 0;
    const body = deflate ? zlib.deflateRawSync(raw, { level: 9 }) : raw;
    const method = deflate ? 8 : 0;
    const crc = crc32(raw);
    const stamp = dosStamp(entry.at || at);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);      // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuffer, body);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(stamp.time, 12);
    header.writeUInt16LE(stamp.date, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(raw.length, 24);
    header.writeUInt16LE(nameBuffer.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBuffer);

    offset += local.length + nameBuffer.length + body.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuffer, end]);
}

/** Reads back the entry names and sizes. Used by the integrity tests. */
function listEntries(archive) {
  const entries = [];
  let position = 0;
  while (position + 4 <= archive.length && archive.readUInt32LE(position) === 0x04034b50) {
    const compressedSize = archive.readUInt32LE(position + 18);
    const uncompressedSize = archive.readUInt32LE(position + 22);
    const nameLength = archive.readUInt16LE(position + 26);
    const extraLength = archive.readUInt16LE(position + 28);
    const method = archive.readUInt16LE(position + 8);
    const crc = archive.readUInt32LE(position + 14);
    const name = archive.subarray(position + 30, position + 30 + nameLength).toString('utf8');
    const dataStart = position + 30 + nameLength + extraLength;
    const body = archive.subarray(dataStart, dataStart + compressedSize);
    const data = method === 8 ? zlib.inflateRawSync(body) : body;
    entries.push({ name, size: uncompressedSize, method, crcMatches: crc32(data) === crc, data });
    position = dataStart + compressedSize;
  }
  return entries;
}

module.exports = { create, listEntries, crc32 };
