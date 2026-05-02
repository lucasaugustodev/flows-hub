// ecosystem.config.js — PM2 deploy config para flows-hub
// Carrega .env (do mesmo diretório) e popula variáveis no processo Node.

const fs = require('fs');
const path = require('path');

function loadDotenv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return {};
  const out = {};
  const content = fs.readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

module.exports = {
  apps: [
    {
      name: 'flows-hub',
      script: 'src/server.js',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '1G',
      env: loadDotenv(),
      out_file: '/var/log/flows-hub/out.log',
      error_file: '/var/log/flows-hub/error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
