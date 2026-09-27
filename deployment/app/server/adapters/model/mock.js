/* Explicitly labelled mock model.
 *
 * It contacts nothing. It requests the same tools in the same Converse message
 * format as a real model, so the agent loop, tool authorisation, tool execution
 * and draft validation are all genuinely exercised. Every run produced with this
 * adapter is recorded and displayed as run_kind = mock-model, and the resulting
 * report is labelled as such: a simulated run is never reported as a live one.
 *
 * It composes the final draft from the values returned by the real tool calls, so
 * it cannot pass validation by hard-coding amounts. */
'use strict';

const NAME = 'mock/deterministic-agent-v1';

/** Pulls the JSON payloads the loop returned for a given tool. */
function toolResults(messages, toolName, toolUseIndex) {
  const results = [];
  for (let i = 0; i < messages.length; i++) {
    for (const block of messages[i].content || []) {
      if (!block.toolUse) continue;
      if (block.toolUse.name !== toolName) continue;
      const useId = block.toolUse.toolUseId;
      for (const later of messages.slice(i + 1)) {
        for (const resultBlock of later.content || []) {
          if (resultBlock.toolResult?.toolUseId === useId) {
            const payload = (resultBlock.toolResult.content || []).find(part => part.json)?.json;
            results.push({ status: resultBlock.toolResult.status, payload });
          }
        }
      }
    }
  }
  return toolUseIndex === undefined ? results : results[toolUseIndex];
}

const called = (messages, toolName) => messages.some(message =>
  (message.content || []).some(block => block.toolUse?.name === toolName));

const textBlock = text => ({ role: 'assistant', content: [{ text }] });
const useBlock = (name, input, n) => ({ role: 'assistant', content: [{ toolUse: { toolUseId: `mock-${name}-${n}`, name, input } }] });

class MockModel {
  constructor({ modelId = NAME } = {}) {
    this.driver = 'mock';
    this.runKind = 'mock-model';
    this.modelId = modelId;
    this.failNextWith = null; // tests use this to drive model-failure handling
  }

  describe() {
    return {
      driver: this.driver,
      runKind: this.runKind,
      modelId: this.modelId,
      region: null,
      guardrail: null,
      note: 'Simulated model. No AWS call is made. Tool execution is real; model reasoning is scripted.'
    };
  }

  async converse({ messages, tools }) {
    if (this.failNextWith) {
      const error = this.failNextWith;
      this.failNextWith = null;
      throw error;
    }
    const available = new Set((tools || []).map(tool => tool.name));
    const turn = messages.filter(message => message.role === 'assistant').length;

    if (available.has('get_records') && !called(messages, 'get_records')) {
      return this.reply('tool_use', useBlock('get_records', { includeTotals: true }, turn));
    }
    if (available.has('run_checks') && !called(messages, 'run_checks')) {
      return this.reply('tool_use', useBlock('run_checks', {}, turn));
    }
    if (available.has('get_reconciliation') && !called(messages, 'get_reconciliation')) {
      return this.reply('tool_use', useBlock('get_reconciliation', {}, turn));
    }
    if (available.has('get_evidence') && !called(messages, 'get_evidence')) {
      return this.reply('tool_use', useBlock('get_evidence', {}, turn));
    }
    if (available.has('save_draft') && !called(messages, 'save_draft')) {
      const draft = this.composeDraft(messages);
      if (!draft) return this.reply('end_turn', textBlock('Insufficient tool results to compose a draft.'));
      return this.reply('tool_use', useBlock('save_draft', { draft }, turn));
    }
    const saved = toolResults(messages, 'save_draft', 0);
    return this.reply('end_turn', textBlock(saved?.status === 'success'
      ? `Draft saved as ${saved.payload?.reportId || 'a new report version'}. Awaiting human review.`
      : 'The draft was rejected by server-side validation and was not saved.'));
  }

  reply(stopReason, message) {
    return { stopReason, message, usage: { inputTokens: null, outputTokens: null }, guardrail: null, latencyMs: 0 };
  }

  /** Builds a draft strictly from tool output, mirroring what a model is asked to do. */
  composeDraft(messages) {
    const checks = toolResults(messages, 'run_checks', 0)?.payload;
    const evidence = toolResults(messages, 'get_evidence', 0)?.payload;
    const records = toolResults(messages, 'get_records', 0)?.payload;
    const reconciliation = toolResults(messages, 'get_reconciliation', 0)?.payload;
    if (!checks?.keyAmounts || !records) return null;

    const files = evidence?.files || [];
    const unreadable = files.filter(file => file.reviewRequired);
    const findings = (checks.findings || []).map(finding => ({
      ruleId: finding.rule,
      recordId: finding.recordId,
      severity: finding.severity,
      explanation: `${finding.title}. ${finding.detail}`,
      riskExplanation: finding.severity === 'blocking'
        ? 'The recorded figures or required references do not reconcile, so the period cannot be reported as reviewed until this is corrected or explained.'
        : 'The system could not confirm this item, so a person must decide whether it is acceptable.',
      evidenceRefs: files.filter(file => file.subjectId === finding.recordId).map(file => file.evidenceId)
    }));

    return {
      summary: `Payroll review for ${checks.period} across ${records.recordCount} record(s). `
        + `Rule set ${checks.ruleVersion} produced ${findings.length} finding(s), `
        + `${checks.blockingCount} of them blocking. Amounts are taken from the server totals and were not calculated by the model.`,
      findings,
      evidenceReferences: files.map(file => ({
        evidenceId: file.evidenceId,
        relevance: file.reviewRequired ? 'Attached file whose content could not be read by the system.' : 'Attached supporting file for this period.'
      })),
      ruleVersions: [checks.ruleVersion],
      keyAmounts: checks.keyAmounts,
      /* Copied from the reconciliation tool result, carrying the status the server
       * proved. Overstating any of these is refused by draft validation. */
      ...(reconciliation?.applicable
        ? {
          financeTotals: {
            bankIn: reconciliation.totals.bankIn,
            bankOut: reconciliation.totals.bankOut,
            bankNetMovement: reconciliation.totals.bankNetMovement,
            currency: 'SGD'
          },
          bankReferences: [
            ...reconciliation.payments.filter(row => row.paymentRef).map(row => ({ reference: row.paymentRef, status: row.status })),
            ...reconciliation.bankTransactions
              .filter(row => row.bankRef && row.status !== 'matched')
              .map(row => ({ reference: row.bankRef, status: row.status }))
          ]
        }
        : {}),
      recommendations: checks.blockingCount
        ? [
          'Correct the source records or record an explanation for every blocking finding, then run the checks again.',
          'Attach the supporting document for each payment reference so amounts can be traced to a file.'
        ]
        : ['Proceed to finance review: the configured rules produced no blocking findings for this data revision.'],
      itemsRequiringHumanReview: [
        ...unreadable.map(file => ({
          item: `Evidence ${file.evidenceId} (${file.filename})`,
          reason: file.reviewReason || 'Content could not be read by the system and has not been verified.'
        })),
        // Unmatched and ambiguous rows are surfaced as open questions, never as
        // reconciled ones; the server refuses the draft if that is reversed.
        ...(reconciliation?.applicable
          ? [...reconciliation.payments, ...reconciliation.bankTransactions]
            .filter(row => row.status !== 'matched')
            .map(row => ({
              item: `Reference ${row.paymentRef || row.bankRef || '(missing)'} is ${row.status}`,
              reason: `${row.detail} It is not reported as confirmed by the bank statement.`
            }))
          : reconciliation
            ? [{ item: 'No bank statement imported', reason: 'No payment can be described as confirmed by a bank until a statement is imported.' }]
            : []),
        ...(checks.blockingCount
          ? [{ item: `${checks.blockingCount} blocking finding(s)`, reason: 'A person must correct or formally accept each one before submission.' }]
          : [{ item: 'Rule coverage', reason: 'A reviewer must confirm the configured rules cover the risks relevant to this period.' }])
      ],
      limitations: ['Draft produced by a simulated model run. No live model was contacted.']
    };
  }
}

module.exports = { MockModel, NAME };
