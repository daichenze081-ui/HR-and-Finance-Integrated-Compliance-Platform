/* Model factory.
 *
 * The agent never selects a driver itself. If a driver is requested but cannot
 * actually run — Bedrock without a region or credentials, Ollama without a model
 * name or with a non-loopback endpoint — config.js resolves it down to the mock
 * adapter and the run is labelled mock-model, so a simulated run can never be
 * presented as a live one. */
'use strict';
const config = require('../../config');
const { BedrockModel } = require('./bedrock');
const { OllamaModel } = require('./ollama');
const { MockModel } = require('./mock');

let override = null;

function createModel(options = {}) {
  if (override) return override;
  const driver = options.driver || config.model.driver;
  if (driver === 'bedrock') {
    return new BedrockModel({
      region: options.region || config.model.region,
      modelId: options.modelId || config.model.modelId,
      credentials: config.awsCredentials,
      maxTokens: config.model.maxTokens,
      guardrailId: config.model.guardrailId,
      guardrailVersion: config.model.guardrailVersion
    });
  }
  if (driver === 'ollama') {
    return new OllamaModel({
      host: options.host || config.model.ollamaUrl,
      modelId: options.modelId || config.model.ollamaModel,
      maxTokens: config.model.maxTokens,
      contextTokens: config.model.ollamaContextTokens
    });
  }
  return new MockModel({ modelId: options.modelId || undefined });
}

/** Tests inject a stub adapter; production code never calls this. */
const setModel = model => { override = model; return model; };
const clearModel = () => { override = null; };

module.exports = { createModel, setModel, clearModel, BedrockModel, OllamaModel, MockModel };
