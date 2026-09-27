/* Amazon S3 evidence storage.
 *
 * Implements the same interface as the local adapter using signed requests, so
 * moving evidence to S3 is a configuration change rather than a code change. It
 * is interface-complete but has not been verified against a live bucket in this
 * stage: without S3_BUCKET and credentials it refuses to start and reports
 * "awaiting configuration" instead of appearing to work. */
'use strict';
const sigv4 = require('../aws/sigv4');
const { notFound, badRequest, failedDependency } = require('../../lib/errors');

const KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;

class S3EvidenceStorage {
  constructor({ bucket, prefix = 'evidence/', region, credentials, timeoutMs = 30000 }) {
    this.driver = 's3';
    this.bucket = bucket;
    this.prefix = prefix.replace(/^\/+/, '');
    this.region = region;
    this.credentials = credentials;
    this.timeoutMs = timeoutMs;
  }

  get configured() { return !!(this.bucket && this.region && this.credentials().accessKeyId); }

  objectPath(key) {
    if (!KEY.test(key) || key.includes('..')) throw badRequest('Unsupported storage key');
    return `/${this.prefix}${key}`;
  }

  assertReady() {
    if (!this.configured) {
      throw failedDependency('S3 evidence storage is selected but not configured', {
        missing: [!this.bucket && 'S3_BUCKET', !this.region && 'AWS_REGION', !this.credentials().accessKeyId && 'AWS credentials'].filter(Boolean)
      });
    }
  }

  async init() { this.assertReady(); return this; }

  async send(method, key, body) {
    this.assertReady();
    const response = await sigv4.request({
      method,
      host: `${this.bucket}.s3.${this.region}.amazonaws.com`,
      path: this.objectPath(key),
      service: 's3',
      region: this.region,
      credentials: this.credentials(),
      headers: body ? { 'content-type': 'application/octet-stream' } : {},
      body: body || '',
      timeoutMs: this.timeoutMs
    });
    return response;
  }

  async put(key, buffer) {
    const response = await this.send('PUT', key, buffer);
    if (response.status !== 200) throw failedDependency(`S3 rejected the upload (HTTP ${response.status})`);
    return { key, driver: this.driver, bytes: buffer.length };
  }

  async get(key) {
    const response = await this.send('GET', key);
    if (response.status === 404) throw notFound('Stored evidence object is missing');
    if (response.status !== 200) throw failedDependency(`S3 rejected the download (HTTP ${response.status})`);
    return response.body;
  }

  async exists(key) {
    const response = await this.send('HEAD', key);
    return response.status === 200;
  }

  async remove() {
    throw badRequest('Evidence objects cannot be deleted. Upload a new version instead.');
  }

  describe() {
    return this.configured
      ? { driver: 's3', state: 'live', detail: `s3://${this.bucket}/${this.prefix}`, immutable: false, verified: false }
      : { driver: 's3', state: 'awaiting-configuration', detail: 'Set S3_BUCKET, AWS_REGION and credentials to enable S3 storage.' };
  }
}

module.exports = { S3EvidenceStorage };
