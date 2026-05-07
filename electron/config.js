const Store = require('electron-store');
const fs = require('node:fs');
const { buildSchema, ALL_KEYS } = require('./config-schema');

const store = new Store({ name: 'config', schema: buildSchema() });

function getConfig() {
  const out = {};
  for (const k of ALL_KEYS) out[k] = store.get(k);
  return out;
}

function setConfig(patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined && ALL_KEYS.includes(k)) store.set(k, v);
  }
  // Restrict the config file to user-only read/write since it stores
  // a path to a Gemini service account key (sensitive).
  try { fs.chmodSync(store.path, 0o600); } catch { /* ignore */ }
  return getConfig();
}

module.exports = { getConfig, setConfig };
