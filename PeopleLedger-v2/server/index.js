/* Server entry point. Starts the data store, evidence storage and HTTP listener,
 * and prints exactly which integrations are live, simulated or unconfigured so a
 * demonstration cannot accidentally overstate what is connected. */
'use strict';
const config = require('./config');
const logger = require('./lib/logger');
const { getStore, closeStore } = require('./adapters/db');
const { getStorage } = require('./adapters/storage');
const { createServer } = require('./http/app');

function warnings() {
  const list = [];
  if (config.db.driver === 'memory') {
    list.push(config.db.requestedDriver === 'memory'
      ? 'DB_DRIVER=memory: records are held in memory and lost on restart.'
      : 'DATABASE_URL is not set: running the in-process store instead of PostgreSQL. Nothing is persisted.');
  }
  if (config.model.driver === 'mock') {
    list.push(config.model.requestedDriver === 'mock'
      ? 'MODEL_DRIVER=mock: agent runs are simulated and labelled MOCK. No model call is made.'
      : config.model.requestedDriver === 'ollama'
        ? 'MODEL_DRIVER=ollama needs OLLAMA_MODEL and an HTTP loopback OLLAMA_URL: agent runs fall back to the labelled mock model.'
        : 'Bedrock is requested but credentials or region are missing: agent runs fall back to the labelled mock model.');
  }
  if (config.model.driver === 'ollama') {
    list.push(`MODEL_DRIVER=ollama: runs call ${config.model.ollamaUrl} on this machine. `
      + 'Choose a model with tool support, or the run produces no draft. Managed guardrails do not apply; draft validation still does.');
  }
  if (config.model.driver === 'bedrock' && !config.model.guardrailId) {
    list.push('No Bedrock guardrail configured. Application-level draft validation still applies.');
  }
  if (config.session.secret.length < 32) list.push('SESSION_SECRET is short or unset. Acceptable on loopback only; set a long value before sharing this server.');
  if (config.http.host !== '127.0.0.1' && config.http.host !== 'localhost') {
    list.push(`The server binds to ${config.http.host}, so it is reachable beyond this machine. All API routes require a session, but use HTTPS and a strong SESSION_SECRET.`);
  }
  return list;
}

async function start() {
  const store = await getStore();
  const storage = await getStorage();
  const server = createServer({ store });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.http.port, config.http.host, resolve);
  });

  const status = config.integrationStatus();
  logger.info('PeopleLedger server ready', {
    url: `http://${config.http.host}:${config.http.port}`,
    database: store.driver,
    evidenceStorage: storage.driver,
    model: `${config.model.driver} (${config.model.driver === 'bedrock' ? config.model.modelId
      : config.model.driver === 'ollama' ? config.model.ollamaModel : 'simulated'})`
  });
  process.stdout.write(`\nPeopleLedger ready: http://${config.http.host}:${config.http.port}\n`);
  process.stdout.write('Integration status:\n');
  for (const [name, entry] of Object.entries(status)) {
    process.stdout.write(`  ${name.padEnd(18)} ${entry.state.padEnd(24)} ${entry.detail}\n`);
  }
  const notices = warnings();
  if (notices.length) {
    process.stdout.write('\nNotices:\n');
    for (const notice of notices) process.stdout.write(`  - ${notice}\n`);
  }
  process.stdout.write('\nSign in with a seeded account. Run "npm run seed" if you have not already.\n\n');

  const shutdown = async signal => {
    logger.info('Shutting down', { signal });
    server.close();
    await closeStore();
    process.exit(0);
  };
  process.on('SIGINT', () => { shutdown('SIGINT'); });
  process.on('SIGTERM', () => { shutdown('SIGTERM'); });
  return server;
}

if (require.main === module) {
  start().catch(error => {
    process.stderr.write(`Failed to start: ${error.message}\n`);
    process.exit(1);
  });
}

module.exports = { start, warnings };
