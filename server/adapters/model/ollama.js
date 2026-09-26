/* Ollama model adapter for a locally hosted model, server side only.
 *
 * Implements exactly the interface the agent loop already uses for Bedrock and for
 * the mock adapter — `driver`, `runKind`, `describe()` and
 * `converse({ system, messages, tools, maxTokens, timeoutMs })` returning
 * `{ stopReason, message, usage, guardrail, latencyMs }` — so the loop, the tool
 * authorisation, the retry policy and the draft validation are shared verbatim and
 * nothing about the run changes except where the tokens come from.
 *
 * The Converse block shape stays the boundary contract: this file translates it to
 * and from the Ollama chat format and back again, so no other file needs to know
 * which model driver is configured.
 *
 * The endpoint is restricted to an HTTP loopback address. A local model driver must
 * not become a way to post case data to an arbitrary host, and redirects are
 * refused for the same reason. Bedrock Guardrails do not exist here, so `guardrail`
 * is always null and the application-level draft validation is the only control —
 * which is why a run made with this driver is labelled with its driver. */
'use strict';
const { failedDependency, timeout: timeoutError } = require('../../lib/errors');

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Refuses anything that is not a plain HTTP loopback origin. */
function loopbackOrigin(raw) {
  let url;
  try { url = new URL(raw); } catch { throw failedDependency(`OLLAMA_URL is not a valid URL: ${raw}`, { retryable: false }); }
  if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname) || url.username || url.password) {
    throw failedDependency('OLLAMA_URL must be a plain HTTP loopback address such as http://127.0.0.1:11434', { retryable: false });
  }
  return url.origin;
}

const textOf = content => (Array.isArray(content) ? content : [])
  .filter(block => typeof block.text === 'string')
  .map(block => block.text)
  .join('\n')
  .trim();

/**
 * Converse blocks -> Ollama chat messages.
 *
 * Ollama carries a tool result in a dedicated `tool` message rather than inside a
 * user turn, so a Converse `toolResult` block becomes its own message. The tool
 * name is recovered from the matching `toolUse` so the local model can associate
 * the result with the call it made.
 */
function toOllamaMessages(system, messages) {
  const names = new Map();
  for (const message of messages) {
    for (const block of message.content || []) {
      if (block.toolUse) names.set(block.toolUse.toolUseId, block.toolUse.name);
    }
  }

  const out = system ? [{ role: 'system', content: system }] : [];
  for (const message of messages) {
    const blocks = Array.isArray(message.content) ? message.content : [];
    const toolResults = blocks.filter(block => block.toolResult);
    const toolUses = blocks.filter(block => block.toolUse);
    const text = textOf(blocks);

    if (toolResults.length) {
      // Tool results are data, never instructions; they are passed through as JSON.
      for (const block of toolResults) {
        const payload = (block.toolResult.content || []).find(part => part.json !== undefined)?.json;
        out.push({
          role: 'tool',
          tool_name: names.get(block.toolResult.toolUseId) || 'tool',
          content: JSON.stringify({ status: block.toolResult.status || 'success', result: payload ?? null })
        });
      }
      if (text) out.push({ role: 'user', content: text });
      continue;
    }

    if (message.role === 'assistant' && toolUses.length) {
      out.push({
        role: 'assistant',
        content: text,
        tool_calls: toolUses.map(block => ({
          function: { name: block.toolUse.name, arguments: block.toolUse.input ?? {} }
        }))
      });
      continue;
    }
    out.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: text });
  }
  return out;
}

/** Neutral tool declarations -> Ollama function tools. */
const toOllamaTools = tools => (tools || []).map(tool => ({
  type: 'function',
  function: { name: tool.name, description: tool.description, parameters: tool.inputSchema }
}));

/** Ollama reply -> Converse message blocks. */
function toConverseMessage(reply) {
  const content = [];
  const text = typeof reply.message?.content === 'string' ? reply.message.content.trim() : '';
  if (text) content.push({ text });
  const calls = Array.isArray(reply.message?.tool_calls) ? reply.message.tool_calls : [];
  calls.forEach((call, index) => {
    const name = call.function?.name;
    if (!name) return;
    let input = call.function?.arguments ?? {};
    // Some builds return the arguments as a JSON string rather than an object.
    if (typeof input === 'string') {
      try { input = JSON.parse(input); } catch { input = {}; }
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) input = {};
    content.push({ toolUse: { toolUseId: `ollama-${index}-${name}`, name, input } });
  });
  return { role: 'assistant', content };
}

class OllamaModel {
  constructor({ host, modelId, maxTokens = 2048, contextTokens = 8192 }) {
    this.driver = 'ollama';
    this.runKind = 'live-model';
    this.origin = loopbackOrigin(host || 'http://127.0.0.1:11434');
    this.modelId = modelId;
    this.maxTokens = maxTokens;
    this.contextTokens = contextTokens;
  }

  describe() {
    return {
      driver: this.driver,
      runKind: this.runKind,
      modelId: this.modelId,
      region: null,
      endpoint: `${this.origin}/api/chat`,
      guardrail: null,
      note: 'Locally hosted model reached over an HTTP loopback address. No managed guardrail applies; '
        + 'server-side draft validation is the only control on the output.'
    };
  }

  async post(path, body, timeoutMs) {
    let response;
    try {
      response = await fetch(`${this.origin}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      if (error.name === 'TimeoutError' || error.name === 'AbortError') {
        throw timeoutError(`The local model did not respond within ${timeoutMs} ms`, { retryable: true });
      }
      throw failedDependency(`Could not reach the local model service at ${this.origin}: ${error.message}`, { retryable: true });
    }

    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw failedDependency('The local model returned an oversized response', { retryable: false });
    if (!response.ok) {
      throw failedDependency(`The local model service returned HTTP ${response.status}: ${text.slice(0, 400)}`, {
        retryable: RETRYABLE_STATUS.has(response.status),
        status: response.status
      });
    }
    try { return JSON.parse(text); } catch {
      throw failedDependency('The local model returned a response that is not valid JSON', { retryable: true });
    }
  }

  /**
   * One model turn.
   * @returns {{stopReason:string, message:object, usage:object, guardrail:null, latencyMs:number|null}}
   */
  async converse({ system, messages, tools, maxTokens, timeoutMs = 30000 }) {
    const reply = await this.post('/api/chat', {
      model: this.modelId,
      stream: false,
      messages: toOllamaMessages(system, messages),
      tools: tools && tools.length ? toOllamaTools(tools) : undefined,
      options: { temperature: 0, num_predict: maxTokens || this.maxTokens, num_ctx: this.contextTokens }
    }, timeoutMs);

    if (!reply.message || reply.message.role !== 'assistant') {
      throw failedDependency('The local model returned no assistant message', { retryable: true });
    }
    const message = toConverseMessage(reply);
    const requestedTools = message.content.some(block => block.toolUse);
    return {
      // The loop only distinguishes "asked for tools" from "finished".
      stopReason: requestedTools ? 'tool_use' : (reply.done_reason === 'length' ? 'max_tokens' : 'end_turn'),
      message,
      usage: {
        inputTokens: Number.isInteger(reply.prompt_eval_count) ? reply.prompt_eval_count : null,
        outputTokens: Number.isInteger(reply.eval_count) ? reply.eval_count : null
      },
      guardrail: null,
      latencyMs: Number.isFinite(reply.total_duration) ? Math.round(reply.total_duration / 1e6) : null
    };
  }
}

module.exports = { OllamaModel, toOllamaMessages, toOllamaTools, toConverseMessage, loopbackOrigin };
