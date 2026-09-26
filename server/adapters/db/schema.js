/* Single description of the persisted shape, shared by the PostgreSQL adapter and
 * the in-process adapter so both behave identically.
 *
 * Conventions
 *  - Money is stored as BIGINT minor units (SGD cents). No floating point.
 *  - Timestamps are ISO-8601 text so the two adapters compare and sort the same
 *    way and no timezone conversion can alter recorded evidence times.
 *  - Flexible payloads (snapshots, rule findings, tool-call traces) are jsonb. */
'use strict';

const TABLES = {
  users: {
    columns: {
      id: 'text', email: 'text', display_name: 'text', role: 'text',
      password_hash: 'text', password_salt: 'text', active: 'int',
      created_at: 'text', last_login_at: 'text'
    },
    unique: ['email']
  },
  sessions: {
    columns: {
      id: 'text', user_id: 'text', token_hash: 'text', created_at: 'text',
      expires_at: 'text', revoked_at: 'text', user_agent: 'text'
    },
    unique: ['token_hash']
  },
  cases: {
    columns: {
      id: 'text', title: 'text', period: 'text', status: 'text',
      data_revision: 'int', rule_set_id: 'text', created_at: 'text', created_by: 'text'
    }
  },
  case_members: {
    columns: {
      id: 'text', case_id: 'text', user_id: 'text', case_role: 'text',
      granted_by: 'text', granted_at: 'text', expires_at: 'text', revoked_at: 'text'
    }
  },
  employees: {
    columns: {
      id: 'text', case_id: 'text', employee_no: 'text', display_name: 'text',
      department: 'text', cost_center: 'text', source: 'text',
      candidate_id: 'text', start_date: 'text', created_at: 'text'
    }
  },
  payroll_records: {
    columns: {
      id: 'text', case_id: 'text', employee_no: 'text', name: 'text',
      department: 'text', cost_center: 'text', period: 'text',
      base_pay_cents: 'bigint', allowances_cents: 'bigint',
      deductions_cents: 'bigint', net_paid_cents: 'bigint',
      evidence_ref: 'text', revision: 'int', created_at: 'text',
      updated_at: 'text', updated_by: 'text'
    }
  },
  record_changes: {
    columns: {
      id: 'text', case_id: 'text', record_id: 'text', revision: 'int',
      note: 'text', changes: 'json', actor_id: 'text', at: 'text'
    }
  },
  rule_sets: {
    columns: {
      id: 'text', version: 'text', label: 'text', disclaimer: 'text',
      config: 'json', created_at: 'text'
    }
  },
  checks: {
    columns: {
      id: 'text', case_id: 'text', data_revision: 'int', rule_version: 'text',
      rule_set_id: 'text', issues: 'json', totals: 'json',
      created_at: 'text', created_by: 'text'
    }
  },
  payment_batches: {
    columns: {
      id: 'text', case_id: 'text', filename: 'text', row_count: 'int',
      total_cents: 'bigint', status: 'text', digest: 'text', source_rows: 'json',
      created_at: 'text', created_by: 'text'
    },
    unique: ['digest']
  },
  ledger_entries: {
    columns: {
      id: 'text', case_id: 'text', batch_id: 'text', source_id: 'text',
      period: 'text', direction: 'text', category: 'text', department: 'text',
      cost_center: 'text', amount_cents: 'bigint', reference: 'text',
      evidence_ref: 'text', description: 'text', value_date: 'text',
      created_at: 'text', created_by: 'text'
    }
  },
  payments: {
    columns: {
      id: 'text', case_id: 'text', batch_id: 'text', employee_no: 'text',
      period: 'text', amount_cents: 'bigint', payment_ref: 'text',
      paid_at: 'text', created_at: 'text', created_by: 'text'
    }
  },
  // Imported third-party bank statements. Same digest-unique batch pattern as the
  // payment ledger, so a repeated submission of one file is detectable.
  bank_batches: {
    columns: {
      id: 'text', case_id: 'text', filename: 'text', source_format: 'text',
      worksheet: 'text', row_count: 'int', in_cents: 'bigint', out_cents: 'bigint',
      status: 'text', digest: 'text', created_at: 'text', created_by: 'text'
    },
    unique: ['digest']
  },
  bank_transactions: {
    columns: {
      id: 'text', case_id: 'text', batch_id: 'text', txn_ref: 'text',
      value_date: 'text', direction: 'text', amount_cents: 'bigint',
      counterparty: 'text', description: 'text', created_at: 'text', created_by: 'text'
    }
  },
  // A reconciliation result is stamped with the data revision and rule version it
  // was produced from, exactly like a check row, so it goes visibly stale.
  reconciliations: {
    columns: {
      id: 'text', case_id: 'text', data_revision: 'int', rule_version: 'text',
      matched_count: 'int', unmatched_count: 'int', ambiguous_count: 'int',
      result: 'json', created_at: 'text', created_by: 'text'
    }
  },
  evidence_files: {
    columns: {
      id: 'text', case_id: 'text', subject_type: 'text', subject_id: 'text',
      filename: 'text', media_type: 'text', size_bytes: 'bigint', sha256: 'text',
      version: 'int', source: 'text', storage_driver: 'text', storage_key: 'text',
      readable: 'int', review_reason: 'text', uploaded_by: 'text',
      uploaded_at: 'text', superseded_by: 'text'
    }
  },
  reports: {
    columns: {
      id: 'text', case_id: 'text', version: 'int', amends_report_id: 'text',
      data_revision: 'int', rule_version: 'text', check_id: 'text',
      status: 'text', mode: 'text', run_kind: 'text', draft_source: 'text',
      agent_run_id: 'text', snapshot: 'json', draft: 'json',
      input_digest: 'text', created_by: 'text', created_at: 'text',
      updated_at: 'text', sealed_at: 'text', sealed_by: 'text', seal_manifest: 'json'
    }
  },
  approvals: {
    columns: {
      id: 'text', report_id: 'text', case_id: 'text', report_version: 'int',
      input_digest: 'text', stage: 'text', decision: 'text', actor_id: 'text',
      actor_role: 'text', note: 'text', at: 'text'
    }
  },
  jobs: {
    columns: {
      id: 'text', case_id: 'text', title: 'text', department: 'text',
      cost_center: 'text', headcount: 'int', salary_min_cents: 'bigint',
      salary_max_cents: 'bigint', description: 'text', status: 'text',
      created_by: 'text', created_at: 'text', opened_at: 'text', closed_at: 'text'
    }
  },
  advertisements: {
    columns: {
      id: 'text', job_id: 'text', channel: 'text', reference: 'text',
      posted_at: 'text', evidence_id: 'text', created_by: 'text', created_at: 'text'
    }
  },
  candidates: {
    columns: {
      id: 'text', job_id: 'text', candidate_ref: 'text', full_name: 'text',
      contact_email: 'text', stage: 'text', expected_start: 'text',
      offer_amount_cents: 'bigint', decision_reason: 'text',
      created_by: 'text', created_at: 'text', updated_at: 'text'
    },
    unique: ['candidate_ref']
  },
  scorecards: {
    columns: {
      id: 'text', candidate_id: 'text', revision: 'int', interviewer_id: 'text',
      criteria: 'json', recommendation: 'text', note: 'text',
      supersedes: 'text', created_at: 'text'
    }
  },
  interviews: {
    columns: {
      id: 'text', candidate_id: 'text', request_key: 'text', organizer_id: 'text',
      provider: 'text', status: 'text', scheduled_start: 'text',
      scheduled_end: 'text', previous_start: 'text', join_url: 'text',
      attempt: 'int', failure_reason: 'text', cancel_reason: 'text',
      created_at: 'text', updated_at: 'text'
    },
    unique: ['request_key']
  },
  agent_runs: {
    columns: {
      id: 'text', case_id: 'text', report_id: 'text', requested_by: 'text',
      mode: 'text', run_kind: 'text', tool_execution: 'text', draft_source: 'text',
      model_id: 'text', prompt_version: 'text', guardrail_id: 'text',
      input_refs: 'json', steps: 'json', status: 'text', failure_stage: 'text',
      output_hash: 'text', error: 'text', tool_calls: 'int',
      started_at: 'text', finished_at: 'text'
    }
  },
  audit_log: {
    columns: {
      id: 'text', at: 'text', actor_id: 'text', actor_role: 'text',
      case_id: 'text', action: 'text', subject_type: 'text', subject_id: 'text',
      detail: 'json', ip: 'text'
    }
  },
  counters: { columns: { id: 'text', value: 'bigint' } }
};

const JSON_COLUMNS = Object.fromEntries(
  Object.entries(TABLES).map(([table, def]) => [
    table, Object.entries(def.columns).filter(([, type]) => type === 'json').map(([name]) => name)
  ])
);

const NUMERIC_COLUMNS = Object.fromEntries(
  Object.entries(TABLES).map(([table, def]) => [
    table, Object.entries(def.columns).filter(([, type]) => type === 'int' || type === 'bigint').map(([name]) => name)
  ])
);

const tableNames = Object.keys(TABLES);
const columnsOf = table => Object.keys(TABLES[table].columns);

function assertTable(table) {
  if (!Object.hasOwn(TABLES, table)) throw new Error(`Unknown table: ${table}`);
  return table;
}

/** Guards against arbitrary identifiers reaching SQL text. */
function assertColumn(table, column) {
  if (!Object.hasOwn(TABLES[assertTable(table)].columns, column)) throw new Error(`Unknown column ${table}.${column}`);
  return column;
}

module.exports = { TABLES, JSON_COLUMNS, NUMERIC_COLUMNS, tableNames, columnsOf, assertTable, assertColumn };
