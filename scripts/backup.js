#!/usr/bin/env node
/**
 * Auto-backup of all flows + project vars from a pageflows API into a git repo.
 * Designed to run as a cron job on the same host as the API.
 *
 * Env vars:
 *   PAGEFLOWS_API        default http://localhost:4100
 *   PAGEFLOWS_KEY        required (api token with read access)
 *   PAGEFLOWS_PROJECT    default hub-portal
 *   BACKUP_REPO          default /opt/pageflows-hub
 *   GIT_USER_NAME        default "pageflows-bot"
 *   GIT_USER_EMAIL       default "bot@pageflows.local"
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const API = process.env.PAGEFLOWS_API || 'http://localhost:4100';
const KEY = process.env.PAGEFLOWS_KEY;
const PROJECT = process.env.PAGEFLOWS_PROJECT || 'hub-portal';
const REPO = process.env.BACKUP_REPO || '/opt/pageflows-hub';
const GIT_USER_NAME = process.env.GIT_USER_NAME || 'pageflows-bot';
const GIT_USER_EMAIL = process.env.GIT_USER_EMAIL || 'bot@pageflows.local';

if (!KEY) { console.error('PAGEFLOWS_KEY env required'); process.exit(1); }
if (!fs.existsSync(REPO)) { console.error(`BACKUP_REPO not found: ${REPO}`); process.exit(1); }

const headers = { 'X-API-Key': KEY, 'X-Project': PROJECT, 'Content-Type': 'application/json' };

async function call(p) {
  const r = await fetch(API + p, { headers });
  if (!r.ok) throw new Error(`${p}: ${r.status} ${await r.text()}`);
  return r.json();
}

function sh(cmd, opts = {}) {
  return execSync(cmd, { stdio: opts.silent ? 'pipe' : 'inherit', cwd: REPO, ...opts });
}

(async () => {
  const flowsDir = path.join(REPO, 'flows');
  const varsDir = path.join(REPO, 'project-vars');
  fs.mkdirSync(flowsDir, { recursive: true });
  fs.mkdirSync(varsDir, { recursive: true });

  // 1. Export all flows
  const list = await call('/api/flows');
  console.log(`[${new Date().toISOString()}] ${list.flows.length} flows in project ${PROJECT}`);
  for (const f of list.flows) {
    const detail = await call(`/api/flows/${encodeURIComponent(f.id)}`);
    fs.writeFileSync(
      path.join(flowsDir, `${f.id}.json`),
      JSON.stringify(detail.json, null, 2) + '\n'
    );
  }

  // 2. Export project vars (with reveal so backup is restorable)
  const vars = await call('/api/project-vars?reveal=true').catch(() => ({ vars: [] }));
  fs.writeFileSync(
    path.join(varsDir, `${PROJECT}.json`),
    JSON.stringify(vars.vars || [], null, 2) + '\n'
  );

  // 3. Configure git identity if needed
  try { sh(`git config user.name "${GIT_USER_NAME}"`, { silent: true }); } catch {}
  try { sh(`git config user.email "${GIT_USER_EMAIL}"`, { silent: true }); } catch {}

  // 4. Stage + check for changes
  sh('git add flows project-vars', { silent: true });
  let dirty = false;
  try {
    sh('git diff --cached --quiet', { silent: true });
  } catch {
    dirty = true;
  }
  if (!dirty) {
    console.log(`[${new Date().toISOString()}] no changes`);
    return;
  }

  // 5. Commit + push
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 16) + 'Z';
  sh(`git commit -m "auto-backup ${ts}"`);
  sh('git push');
  console.log(`[${new Date().toISOString()}] pushed`);
})().catch(e => {
  console.error('backup failed:', e.message);
  process.exit(1);
});
