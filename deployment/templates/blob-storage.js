'use strict';
// Server-only adapter. SDK URLs and credentials never leave this module.
const { sha256 } = require('../../lib/hash');
const { badRequest, notFound, failedDependency, tooLarge } = require('../../lib/errors');
const KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;
class BlobEvidenceStorage {
  constructor({ token, prefix = 'evidence/', maxBytes = 4000000, sdk = null }) {
    this.driver = 'blob';
    this.token = token;
    this.prefix = prefix;
    this.maxBytes = maxBytes;
    this.sdk = sdk;
    if (!KEY.test(prefix) || prefix.includes('..')) throw badRequest('Invalid Blob evidence prefix');
    if (!this.prefix.endsWith('/')) this.prefix += '/';
  }
  async init() {
    if (!this.token?.()) throw failedDependency('Private Blob storage is not configured');
    this.sdk ||= require('@vercel/blob');
    return this;
  }
  pathname(key) {
    if (!KEY.test(key) || key.includes('..')) throw badRequest('Unsupported storage key');
    return this.prefix + key;
  }
  options(extra = {}) {
    const token = this.token?.();
    if (!token) throw failedDependency('Private Blob storage is not configured');
    return { ...extra, token, abortSignal: AbortSignal.timeout(30000) };
  }
  assertPrivate(blob) {
    let url;
    try { url = new URL(blob?.url); } catch { throw failedDependency('Private Blob returned invalid metadata'); }
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.private.blob.vercel-storage.com')) {
      throw failedDependency('Evidence storage must use a private Blob store');
    }
  }
  async put(key, buffer) {
    const pathname = this.pathname(key);
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw badRequest('Evidence content must be nonempty bytes');
    if (buffer.length > this.maxBytes) throw tooLarge('Evidence exceeds the cloud upload limit');
    const expectedHash = key.split('/').at(-1);
    if (!/^[a-f0-9]{64}$/.test(expectedHash) || sha256(buffer) !== expectedHash) throw badRequest('Evidence bytes do not match their content-addressed key');
    try {
      const blob = await this.sdk.put(pathname, buffer, this.options({
        access: 'private', addRandomSuffix: false, allowOverwrite: false,
        contentType: 'application/octet-stream'
      }));
      this.assertPrivate(blob);
    } catch {
      // Retries succeed only when the existing stored bytes are identical.
      let existing;
      try { existing = await this.get(key); } catch { throw failedDependency('Private evidence upload failed'); }
      if (!existing.equals(buffer)) throw failedDependency('Existing evidence does not match the expected content');
    }
    return { key, driver: this.driver, bytes: buffer.length };
  }
  async get(key) {
    const pathname = this.pathname(key);
    let result;
    try { result = await this.sdk.get(pathname, this.options({ access: 'private', useCache: false })); }
    catch { throw failedDependency('Private evidence could not be read'); }
    if (!result) throw notFound('Stored evidence object is missing');
    if (result.statusCode !== 200 || !result.stream) throw failedDependency('Private evidence returned no readable content');
    this.assertPrivate(result.blob);
    if (result.blob.size > this.maxBytes) {
      await result.stream.cancel();
      throw tooLarge('Stored evidence exceeds the cloud download limit');
    }
    const reader = result.stream.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        const bytes = Buffer.from(part.value);
        size += bytes.length;
        if (size > this.maxBytes) { await reader.cancel(); throw tooLarge('Stored evidence exceeds the cloud download limit'); }
        chunks.push(bytes);
      }
      return Buffer.concat(chunks);
    } catch (error) {
      if (error?.status === 413) throw error;
      throw failedDependency('Private evidence stream could not be read');
    } finally { reader.releaseLock(); }
  }
  async exists(key) {
    let metadata;
    try { metadata = await this.sdk.head(this.pathname(key), this.options()); }
    catch (error) {
      if (error?.name === 'BlobNotFoundError' || (this.sdk.BlobNotFoundError && error instanceof this.sdk.BlobNotFoundError)) return false;
      throw failedDependency('Private evidence metadata could not be read');
    }
    this.assertPrivate(metadata);
    return true;
  }
  async remove() { throw badRequest('Evidence cannot be deleted. Upload a new version instead.'); }
  describe() {
    return { driver: 'blob', state: this.token?.() ? 'live' : 'awaiting-configuration', detail: 'Private Vercel Blob; downloads require application authorization.', immutable: false, verified: false };
  }
}
module.exports = { BlobEvidenceStorage };
