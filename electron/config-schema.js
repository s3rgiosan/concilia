// Single source of truth for the user-editable config.
// Used by: electron-store schema (electron/config.js), the IPC restart-diff
// logic (electron/main.js), and the renderer Settings drawer (mirror in TS).
const CONFIG_FIELDS = [
  { key: 'receiptsRoot',   type: 'string', default: '',                   serverEnv: true },
  { key: 'saKeyPath',      type: 'string', default: '',                   serverEnv: true },
  { key: 'geminiProject',  type: 'string', default: '',                   serverEnv: true },
  { key: 'geminiLocation', type: 'string', default: 'europe-west1',       serverEnv: true },
  { key: 'geminiModel',    type: 'string', default: 'gemini-2.5-flash',   serverEnv: true },
  { key: 'language',       type: 'string', default: 'en', enum: ['en', 'pt'], serverEnv: false },
];

function buildSchema() {
  const schema = {};
  for (const f of CONFIG_FIELDS) {
    schema[f.key] = { type: f.type, default: f.default };
    if (f.enum) schema[f.key].enum = f.enum;
  }
  return schema;
}

function defaultConfig() {
  const out = {};
  for (const f of CONFIG_FIELDS) out[f.key] = f.default;
  return out;
}

const SERVER_ENV_KEYS = CONFIG_FIELDS.filter((f) => f.serverEnv).map((f) => f.key);
const ALL_KEYS = CONFIG_FIELDS.map((f) => f.key);

module.exports = { CONFIG_FIELDS, buildSchema, defaultConfig, SERVER_ENV_KEYS, ALL_KEYS };
