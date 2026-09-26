/* Evidence files.
 *
 * Every stored object records its source, uploader, timestamp, version and
 * SHA-256. Objects are never deleted: a correction uploads a new version and the
 * superseded version stays readable and hashed. Content that cannot be read as
 * text is marked as requiring manual review rather than being described as
 * verified, because no OCR or document parsing is implemented in this stage. */
'use strict';
const clock = require('../lib/clock');
const { id } = require('../lib/ids');
const { sha256 } = require('../lib/hash');
const validate = require('../lib/validate');
const config = require('../config');
const { badRequest, notFound, forbidden, tooLarge } = require('../lib/errors');
const access = require('../auth/access');
const audit = require('./audit.service');
const { getStorage } = require('../adapters/storage');

const SUBJECT_TYPES = ['payroll_record', 'payment_reference', 'job_advertisement', 'candidate', 'case', 'report'];
const SOURCES = ['upload', 'payroll_system_export', 'bank_statement', 'job_board', 'interview', 'other'];

const TEXTUAL = new Map([
  ['text/plain', 'txt'], ['text/csv', 'csv'], ['text/markdown', 'md'],
  ['application/json', 'json'], ['text/html', 'html']
]);

const ALLOWED_MEDIA = new Set([
  ...TEXTUAL.keys(),
  'application/pdf', 'image/png', 'image/jpeg', 'image/webp',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/octet-stream'
]);

/**
 * Decides whether the bytes can be read by this system. Only genuinely decodable
 * text counts as readable; documents needing OCR or format parsing are flagged
 * for a person.
 */
function assessReadability(buffer, mediaType) {
  if (!buffer.length) return { readable: 0, reason: 'The uploaded file is empty.' };
  if (TEXTUAL.has(mediaType)) {
    const text = buffer.toString('utf8');
    if (text.includes('\uFFFD')) return { readable: 0, reason: 'The file is declared as text but is not valid UTF-8.' };
    // eslint-disable-next-line no-control-regex
    if (/[\x00]/.test(text)) return { readable: 0, reason: 'The file contains null bytes and is not usable text.' };
    return { readable: 1, reason: null, extractedLength: text.length };
  }
  if (mediaType === 'application/pdf') {
    const header = buffer.subarray(0, 5).toString('latin1');
    if (header !== '%PDF-') return { readable: 0, reason: 'Declared as PDF but the file header is not %PDF-.' };
    return { readable: 0, reason: 'PDF content is not machine-read in this stage (OCR and document parsing are out of scope). A person must review the document.' };
  }
  return { readable: 0, reason: `Content of type ${mediaType} is not machine-read in this stage. A person must review the document.` };
}

const publicFile = row => ({
  id: row.id,
  caseId: row.case_id,
  subjectType: row.subject_type,
  subjectId: row.subject_id,
  filename: row.filename,
  mediaType: row.media_type,
  sizeBytes: row.size_bytes,
  sha256: row.sha256,
  version: row.version,
  source: row.source,
  storage: row.storage_driver,
  readable: row.readable === 1,
  reviewRequired: row.readable !== 1,
  reviewReason: row.review_reason || null,
  uploadedBy: row.uploaded_by,
  uploadedAt: row.uploaded_at,
  supersededBy: row.superseded_by || null,
  verificationStatus: row.readable === 1 ? 'content-readable (not authenticated)' : 'requires manual review'
});

/**
 * Stores an uploaded file.
 * @param {Buffer} buffer raw bytes; treated as untrusted data and never executed or interpreted
 */
async function upload(ctx, caseId, meta, buffer) {
  await access.requireCase(ctx, caseId, 'evidence.upload');
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw badRequest('Upload body is empty');
  if (buffer.length > config.evidence.maxBytes) throw tooLarge(`Evidence files must not exceed ${config.evidence.maxBytes} bytes`);

  const filename = validate.filename(meta.filename);
  const subjectType = validate.oneOf(meta.subjectType, SUBJECT_TYPES, 'subjectType');
  const subjectId = validate.text(meta.subjectId, 'subjectId', { max: 120 });
  const source = validate.oneOf(meta.source || 'upload', SOURCES, 'source');
  const mediaType = validate.oneOf((meta.mediaType || 'application/octet-stream').split(';')[0].trim().toLowerCase(), [...ALLOWED_MEDIA], 'mediaType');

  const hash = sha256(buffer);
  const siblings = await ctx.store.find('evidence_files', { case_id: caseId, subject_type: subjectType, subject_id: subjectId });

  // Duplicate-write protection: the same bytes for the same subject are not stored twice.
  const identical = siblings.find(row => row.sha256 === hash && !row.superseded_by);
  if (identical) {
    await audit.record(ctx, 'evidence.upload_duplicate', {
      caseId, subjectType: 'evidence', subjectId: identical.id,
      detail: { sha256: hash, filename, existingVersion: identical.version }
    });
    return { file: publicFile(identical), duplicate: true, note: 'Identical content is already stored for this subject. No new version was created.' };
  }

  const chain = siblings.filter(row => row.filename === filename);
  const version = chain.length ? Math.max(...chain.map(row => row.version)) + 1 : 1;
  const readability = assessReadability(buffer, mediaType);
  const storage = await getStorage();
  const key = `${caseId}/${subjectType}/${hash.slice(0, 2)}/${hash}`;

  await storage.put(key, buffer);
  const now = clock.now();
  const row = await ctx.store.tx(async store => {
    const inserted = await store.insert('evidence_files', {
      id: id('evd'),
      case_id: caseId,
      subject_type: subjectType,
      subject_id: subjectId,
      filename,
      media_type: mediaType,
      size_bytes: buffer.length,
      sha256: hash,
      version,
      source,
      storage_driver: storage.driver,
      storage_key: key,
      readable: readability.readable,
      review_reason: readability.reason,
      uploaded_by: ctx.actor.id,
      uploaded_at: now,
      superseded_by: null
    });
    // Mark the previous version of the same document as superseded, retaining it.
    const previous = chain.filter(r => !r.superseded_by);
    for (const old of previous) await store.update('evidence_files', old.id, { superseded_by: inserted.id });
    return inserted;
  });

  await audit.record(ctx, 'evidence.uploaded', {
    caseId, subjectType: 'evidence', subjectId: row.id,
    detail: {
      filename, mediaType, sizeBytes: buffer.length, sha256: hash, version, source,
      storage: storage.driver, readable: readability.readable === 1, reviewReason: readability.reason
    }
  });
  return { file: publicFile(row), duplicate: false };
}

async function list(ctx, caseId, filters = {}) {
  await access.requireCase(ctx, caseId, 'evidence.read');
  const where = { case_id: caseId };
  if (filters.subjectType) where.subject_type = validate.oneOf(filters.subjectType, SUBJECT_TYPES, 'subjectType');
  if (filters.subjectId) where.subject_id = validate.text(filters.subjectId, 'subjectId', { max: 120 });
  const rows = await ctx.store.find('evidence_files', where, { order: [['uploaded_at', 'desc'], ['id', 'desc']] });
  if (ctx.actor.role === 'auditor') {
    await audit.record(ctx, 'auditor.access.read', { caseId, subjectType: 'evidence_index', subjectId: caseId, detail: { fileCount: rows.length } });
  }
  return rows.map(publicFile);
}

async function get(ctx, evidenceId) {
  const row = await ctx.store.get('evidence_files', evidenceId);
  if (!row) throw notFound(`Evidence not found: ${evidenceId}`);
  await access.requireCase(ctx, row.case_id, 'evidence.read');
  return publicFile(row);
}

/** Authorised download. The object is fetched from storage, re-hashed and only
 *  returned if the bytes still match the recorded digest. */
async function download(ctx, evidenceId) {
  const row = await ctx.store.get('evidence_files', evidenceId);
  if (!row) throw notFound(`Evidence not found: ${evidenceId}`);
  await access.requireCase(ctx, row.case_id, 'evidence.download');
  const storage = await getStorage();
  const buffer = await storage.get(row.storage_key);
  const actual = sha256(buffer);
  const intact = actual === row.sha256;

  await audit.record(ctx, 'evidence.download', {
    caseId: row.case_id, subjectType: 'evidence', subjectId: row.id,
    detail: { filename: row.filename, sha256: row.sha256, integrityVerified: intact, version: row.version }
  });
  if (!intact) {
    throw forbidden('Stored evidence failed its integrity check and was not returned', { evidenceId, expectedSha256: row.sha256, actualSha256: actual });
  }
  return { buffer, file: publicFile(row) };
}

/** Reads evidence content for the agent. Unreadable content is reported as such
 *  and no text is fabricated for it. */
async function readForAgent(ctx, evidenceId, { maxChars = 4000 } = {}) {
  const row = await ctx.store.get('evidence_files', evidenceId);
  if (!row) throw notFound(`Evidence not found: ${evidenceId}`);
  await access.requireCase(ctx, row.case_id, 'evidence.read');
  const meta = publicFile(row);
  if (row.readable !== 1) {
    return { ...meta, content: null, contentAvailable: false, manualReviewRequired: true };
  }
  const storage = await getStorage();
  const buffer = await storage.get(row.storage_key);
  if (sha256(buffer) !== row.sha256) {
    return { ...meta, content: null, contentAvailable: false, manualReviewRequired: true, reviewReason: 'Stored bytes no longer match the recorded SHA-256.' };
  }
  const text = buffer.toString('utf8');
  return {
    ...meta,
    content: text.slice(0, maxChars),
    truncated: text.length > maxChars,
    contentAvailable: true,
    manualReviewRequired: false
  };
}

/** Manifest used by checks, reports and export packages. */
async function manifest(store, caseId) {
  const rows = await store.find('evidence_files', { case_id: caseId }, { order: [['uploaded_at', 'asc']] });
  return rows.map(publicFile);
}

module.exports = {
  SUBJECT_TYPES, SOURCES, ALLOWED_MEDIA,
  upload, list, get, download, readForAgent, manifest, publicFile, assessReadability
};
