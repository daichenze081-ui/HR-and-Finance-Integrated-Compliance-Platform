/* Amazon Bedrock model adapter, server side only.
 *
 * Uses the Converse API (POST /model/{modelId}/converse) so the tool-use contract
 * is model agnostic, and applies Bedrock Guardrails through guardrailConfig in
 * addition to the application-level validation performed on every draft.
 *
 * Credentials never leave the server and are never written to logs or responses. */
'use strict';
const sigv4 = require('../aws/sigv4');
const { failedDependency, timeout: timeoutError } = require('../../lib/errors');

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_CODE = new Set(['ThrottlingException', 'ServiceUnavailableException', 'ModelTimeoutException', 'InternalServerException']);

class BedrockModel {
  constructor({ region, modelId, credentials, maxTokens = 2048, guardrailId = '', guardrailVersion = '' }) {
    this.driver = 'bedrock';
    this.runKind = 'live-model';
    this.region = region;
    this.modelId = modelId;
    this.credentials = credentials;
    this.maxTokens = maxTokens;
    this.guardrailId = guardrailId;
    this.guardrailVersion = guardrailVersion;
  }

  describe() {
    return {
      driver: this.driver,
      runKind: this.runKind,
      modelId: this.modelId,
      region: this.region,
      guardrail: this.guardrailId ? { id: this.guardrailId, version: this.guardrailVersion || 'DRAFT' } : null
    };
  }

  /** Converts the neutral tool declarations into Bedrock toolConfig. */
  static toolConfig(tools) {
    if (!tools?.length) return undefined;
    return {
      tools: tools.map(tool => ({
        toolSpec: {
          name: tool.name,
          description: tool.description,
          inputSchema: { json: tool.inputSchema }
        }
      })),
      toolChoice: { auto: {} }
    };
  }

  /**
   * One model turn.
   * @returns {{stopReason:string, message:object, usage:object, guardrail:object|null}}
   */
  async converse({ system, messages, tools, maxTokens, timeoutMs = 30000 }) {
    const body = {
      messages,
      system: system ? [{ text: system }] : undefined,
      inferenceConfig: { maxTokens: maxTokens || this.maxTokens, temperature: 0 },
      toolConfig: BedrockModel.toolConfig(tools)
    };
    if (this.guardrailId) {
      body.guardrailConfig = {
        guardrailIdentifier: this.guardrailId,
        guardrailVersion: this.guardrailVersion || 'DRAFT',
        trace: 'enabled'
      };
    }

    let response;
    try {
      response = await sigv4.request({
        method: 'POST',
        host: `bedrock-runtime.${this.region}.amazonaws.com`,
        path: `/model/${this.modelId}/converse`,
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        service: 'bedrock',
        region: this.region,
        credentials: this.credentials(),
        timeoutMs
      });
    } catch (error) {
      if (error.code === 'timeout') throw timeoutError(`The model did not respond within ${timeoutMs} ms`, { retryable: true });
      if (error.code === 'no_credentials') throw failedDependency('Bedrock credentials are not configured', { retryable: false });
      throw failedDependency(`Could not reach Amazon Bedrock: ${error.message}`, { retryable: true });
    }

    const text = response.body.toString('utf8');
    if (response.status !== 200) {
      let code = '';
      let message = text.slice(0, 400);
      try { const parsed = JSON.parse(text); code = parsed.__type || parsed.code || ''; message = parsed.message || message; } catch { /* non-JSON error body */ }
      const retryable = RETRYABLE_STATUS.has(response.status) || [...RETRYABLE_CODE].some(c => code.includes(c));
      throw failedDependency(`Bedrock returned HTTP ${response.status}: ${message}`, { retryable, status: response.status, awsErrorType: code || null });
    }

    let parsed;
    try { parsed = JSON.parse(text); } catch { throw failedDependency('Bedrock returned a response that is not valid JSON', { retryable: true }); }

    return {
      stopReason: parsed.stopReason,
      message: parsed.output?.message || { role: 'assistant', content: [] },
      usage: parsed.usage || null,
      guardrail: parsed.trace?.guardrail
        ? { intervened: parsed.stopReason === 'guardrail_intervened', actionReason: parsed.trace.guardrail.actionReason || null }
        : null,
      latencyMs: parsed.metrics?.latencyMs ?? null
    };
  }
}

module.exports = { BedrockModel };
