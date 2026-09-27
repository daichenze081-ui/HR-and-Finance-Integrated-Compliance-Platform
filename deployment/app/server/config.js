/* Central configuration. Secrets stay in the process environment and are never
 * serialised into API responses, logs or the browser bundle. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/** Minimal .env reader. Existing process environment always wins. */
function loadEnvFile(file = path.join(ROOT, '.env')) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^(".*"|'.*')$/s.test(value)) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadEnvFile();

const str = (key, fallback = '') => (process.env[key] ?? '').trim() || fallback;
const int = (key, fallback) => {
  const raw = str(key);
  if (!raw) return fallback; // an unset or blank variable must not read as 0
  const n = Number(raw);
  return Number.isInteger(n) ? n : fallback;
};
const bool = (key, fallback = false) => {
  const v = str(key).toLowerCase();
  if (!v) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v);
};

const dbDriverRaw = str('DB_DRIVER', str('DATABASE_URL') ? 'postgres' : 'sqlite').toLowerCase();
const databaseUrl = str('DATABASE_URL');
// A postgres driver without a connection string cannot start silently: the caller
// is told which driver is actually in use so nothing is reported as persisted
// when it is not.
if (!['sqlite', 'postgres', 'memory'].includes(dbDriverRaw)) throw new Error('DB_DRIVER must be sqlite, postgres or memory');
if (dbDriverRaw === 'postgres' && !databaseUrl) throw new Error('DB_DRIVER=postgres requires DATABASE_URL');
const dbDriver = dbDriverRaw;

const modelDriverRaw = str('MODEL_DRIVER', 'mock').toLowerCase();
const hasStaticAwsKeys = !!(str('AWS_ACCESS_KEY_ID') && str('AWS_SECRET_ACCESS_KEY'));
const hasAmbientRole = !!(str('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI') || str('AWS_WEB_IDENTITY_TOKEN_FILE'));

// A locally hosted model must be reached over an HTTP loopback address. Anything
// else would turn the local driver into a way of posting case data to a remote
// host, so it is refused here rather than at request time.
const ollamaUrl = str('OLLAMA_URL', 'http://127.0.0.1:11434');
const ollamaModel = str('OLLAMA_MODEL');
const ollamaUsable = (() => {
  if (!ollamaModel) return false;
  try {
    const url = new URL(ollamaUrl);
    return url.protocol === 'http:'
      && ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)
      && !url.username && !url.password;
  } catch { return false; }
})();

const config = {
  root: ROOT,
  env: str('NODE_ENV', 'development'),
  http: {
    port: int('PORT', 4173),
    host: str('HOST', '127.0.0.1'),
    corsOrigins: str('CORS_ORIGINS').split(',').map(s => s.trim()).filter(Boolean),
    maxJsonBytes: int('MAX_JSON_BYTES', 8 * 1024 * 1024)
  },
  db: {
    driver: dbDriver,
    requestedDriver: dbDriverRaw,
    url: databaseUrl,
    filename: path.resolve(ROOT, str('SQLITE_PATH', 'var/peopleledger.sqlite')),
    ssl: str('PGSSLMODE', 'disable').toLowerCase() === 'require',
    migrationsDir: path.join(__dirname, 'db', 'migrations')
  },
  session: {
    secret: str('SESSION_SECRET'),
    ttlMinutes: int('SESSION_TTL_MINUTES', 480),
    cookie: 'pl_session'
  },
  seed: { password: str('SEED_PASSWORD', 'Demo!Passw0rd') },
  evidence: {
    driver: str('EVIDENCE_DRIVER', 'local').toLowerCase(),
    localDir: path.resolve(ROOT, str('EVIDENCE_LOCAL_DIR', 'var/evidence')),
    maxBytes: int('EVIDENCE_MAX_BYTES', 5 * 1024 * 1024),
    s3Bucket: str('S3_BUCKET'),
    s3Prefix: str('S3_PREFIX', 'evidence/')
  },
  model: {
    requestedDriver: modelDriverRaw,
    // A real call requires a driver that can actually reach a model: Bedrock needs
    // a region and usable credentials, Ollama needs a model name and a loopback
    // endpoint. Otherwise the adapter degrades to an explicitly labelled mock
    // instead of pretending.
    driver: modelDriverRaw === 'bedrock' && str('AWS_REGION') && (hasStaticAwsKeys || hasAmbientRole)
      ? 'bedrock'
      : modelDriverRaw === 'ollama' && ollamaUsable
        ? 'ollama'
        : 'mock',
    credentialsAvailable: hasStaticAwsKeys || hasAmbientRole,
    ollamaUrl,
    ollamaModel,
    ollamaContextTokens: int('OLLAMA_CONTEXT_TOKENS', 8192),
    region: str('AWS_REGION', 'ap-southeast-1'),
    modelId: str('BEDROCK_MODEL_ID', 'anthropic.claude-3-5-sonnet-20241022-v2:0'),
    anthropicVersion: str('BEDROCK_ANTHROPIC_VERSION', 'bedrock-2023-05-31'),
    maxTokens: int('BEDROCK_MAX_TOKENS', 2048),
    guardrailId: str('BEDROCK_GUARDRAIL_ID'),
    guardrailVersion: str('BEDROCK_GUARDRAIL_VERSION')
  },
  agent: {
    maxToolCalls: int('AGENT_MAX_TOOL_CALLS', 8),
    stepTimeoutMs: int('AGENT_STEP_TIMEOUT_MS', 30000),
    runTimeoutMs: int('AGENT_RUN_TIMEOUT_MS', 120000),
    maxRetries: int('AGENT_MAX_RETRIES', 2)
  },
  interviews: {
    provider: str('INTERVIEW_PROVIDER', 'simulated-teams'),
    forceFailure: bool('INTERVIEW_FORCE_FAILURE', false)
  }
};

/** Credentials are resolved lazily and never cached in the exported object. */
config.awsCredentials = () => ({
  accessKeyId: str('AWS_ACCESS_KEY_ID'),
  secretAccessKey: str('AWS_SECRET_ACCESS_KEY'),
  sessionToken: str('AWS_SESSION_TOKEN')
});

/** Safe integration status for the UI and README. No secret values included. */
config.integrationStatus = () => ({
  database: config.db.driver === 'postgres'
    ? { state: 'live', detail: 'PostgreSQL persistence' }
    : config.db.driver === 'sqlite' ? { state: 'live', detail: 'SQLite local persistence' } : {
      state: config.db.requestedDriver === 'memory' ? 'simulated' : 'awaiting-configuration',
      detail: config.db.requestedDriver === 'memory'
        ? 'In-process store selected. Data is lost on restart.'
        : 'DATABASE_URL is not set. Running the in-process store instead of PostgreSQL.'
    },
  model: config.model.driver === 'bedrock'
    ? { state: 'live', detail: `Amazon Bedrock Converse · ${config.model.modelId}` }
    : config.model.driver === 'ollama'
      ? {
        state: 'live',
        detail: `Locally hosted model via Ollama · ${config.model.ollamaModel} at ${config.model.ollamaUrl}. `
          + 'Reachability and tool support are confirmed only when a run succeeds.'
      }
      : {
        state: config.model.requestedDriver === 'mock' ? 'simulated' : 'awaiting-configuration',
        detail: config.model.requestedDriver === 'mock'
          ? 'Mock model driver selected. No model call is made.'
          : config.model.requestedDriver === 'ollama'
            ? 'OLLAMA_MODEL is unset or OLLAMA_URL is not an HTTP loopback address. Mock model driver in use; runs are labelled MOCK.'
            : 'AWS region or credentials unavailable. Mock model driver in use; runs are labelled MOCK.'
      },
  guardrails: config.model.guardrailId && config.model.driver === 'bedrock'
    ? { state: 'live', detail: `Guardrail ${config.model.guardrailId} v${config.model.guardrailVersion || 'DRAFT'}` }
    : {
      state: 'awaiting-configuration',
      detail: config.model.driver === 'ollama'
        ? 'Managed guardrails apply to Amazon Bedrock only. With the local driver, server-side draft validation is the sole control.'
        : 'No Bedrock guardrail configured. Application-level validation still applies.'
    },
  evidenceStorage: config.evidence.driver === 'blob'
    ? { state: process.env.BLOB_READ_WRITE_TOKEN ? 'live' : 'awaiting-configuration', detail: 'Private Vercel Blob. Access is checked by the application; provider connectivity is confirmed on upload/download.' }
    : config.evidence.driver === 's3'
    ? (config.evidence.s3Bucket
      ? { state: 'live', detail: `S3 bucket ${config.evidence.s3Bucket}` }
      : { state: 'awaiting-configuration', detail: 'S3 driver selected without S3_BUCKET.' })
    : { state: 'live', detail: 'Protected local filesystem storage' },
  teamsScheduling: { state: 'simulated', detail: 'Simulated Teams scheduling. No Microsoft Graph call is made.' },
  bankReconciliation: {
    state: 'live',
    detail: 'Bank statements are imported from CSV or .xlsx and reconciled against the payment ledger and payroll on the server. '
      + 'A direct bank API connection is not part of this stage.'
  },
  payrollConnectors: { state: 'deferred', detail: 'ERP connectors, live banking APIs, OCR and vector search are out of scope for this stage.' },
  enterpriseSso: { state: 'deferred', detail: 'Local password accounts only. Enterprise SSO deferred.' }
});

module.exports = config;
