#!/usr/bin/env node
/**
 * pageflows server — record once, replay N times.
 */
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const db = require('./db');
const auth = require('./auth');
const { authMiddleware } = auth;
const projects = require('./projects');
const sessions = require('./sessions');
const actions = require('./actions');
const email = require('./email');
const { executeReplay, runFlowOnSession } = require('./replay');
const cron = require('./cron');
const scheduler = require('./scheduler');
const llmLinter = require('./llm-linter');

// One-time migration: adopt orphan flows into "Hub Portal".
projects.runMigration();

const PORT = parseInt(process.env.PORT || '4100', 10);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const DATA_DIR = process.env.DATA_DIR || './data';

const app = express();
app.use(express.json({ limit: '5mb' }));

// ===== test accounts page =====
const TEST_ACCOUNTS_FILE = path.join(DATA_DIR, 'test-accounts.json');
function loadTestAccounts() {
  try { return JSON.parse(fs.readFileSync(TEST_ACCOUNTS_FILE, 'utf8')); } catch { return []; }
}
function saveTestAccounts(accounts) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TEST_ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
}

app.get('/test-accounts', (_req, res) => {
  const accounts = loadTestAccounts();
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Contas de Teste — Hub Portal v2</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8fafc; color: #1e293b; }
    .header { background: #1e293b; color: white; padding: 16px 24px; display: flex; align-items: center; gap: 12px; }
    .header h1 { font-size: 18px; font-weight: 600; }
    .header a { color: #94a3b8; font-size: 13px; text-decoration: none; margin-left: auto; }
    .header a:hover { color: white; }
    .container { max-width: 1100px; margin: 0 auto; padding: 24px 16px; }
    .card { background: white; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.08); overflow: hidden; }
    .card-header { padding: 16px 20px; border-bottom: 1px solid #f1f5f9; display: flex; justify-content: space-between; align-items: center; }
    .card-header h2 { font-size: 15px; font-weight: 600; color: #334155; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { background: #f8fafc; padding: 10px 16px; text-align: left; font-weight: 600; color: #64748b; border-bottom: 1px solid #e2e8f0; }
    td { padding: 12px 16px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #fafafa; }
    .badge { display: inline-block; background: #e0f2fe; color: #0369a1; padding: 2px 8px; border-radius: 99px; font-size: 11px; font-weight: 500; margin: 2px 2px 2px 0; }
    .badge.green { background: #dcfce7; color: #15803d; }
    .badge.orange { background: #ffedd5; color: #c2410c; }
    .btn { padding: 7px 14px; border-radius: 8px; font-size: 12px; font-weight: 500; cursor: pointer; border: none; transition: background .15s; }
    .btn-primary { background: #3b82f6; color: white; }
    .btn-primary:hover { background: #2563eb; }
    .btn-danger { background: #fee2e2; color: #dc2626; }
    .btn-danger:hover { background: #fecaca; }
    .btn-sm { padding: 4px 10px; font-size: 11px; }
    .form-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; padding: 16px 20px; background: #f8fafc; border-bottom: 1px solid #e2e8f0; }
    .form-group { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 150px; }
    .form-group label { font-size: 11px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: .03em; }
    input, textarea { padding: 8px 10px; border: 1px solid #e2e8f0; border-radius: 8px; font-size: 13px; font-family: inherit; }
    input:focus, textarea:focus { outline: 2px solid #3b82f6; border-color: transparent; }
    textarea { resize: vertical; min-height: 60px; }
    .mono { font-family: 'SFMono-Regular', Consolas, monospace; font-size: 12px; }
    .empty { padding: 40px; text-align: center; color: #94a3b8; }
    .date { color: #94a3b8; font-size: 11px; }
    .actions { display: flex; gap: 6px; }
  </style>
</head>
<body>
  <div class="header">
    <span>🧪</span>
    <h1>Contas de Teste — Hub Portal v2</h1>
    <a href="/app/">← Voltar ao flows-hub</a>
  </div>
  <div class="container">
    <div class="card">
      <div class="card-header">
        <h2>Contas cadastradas (${accounts.length})</h2>
      </div>
      <div class="form-row" id="add-form">
        <div class="form-group">
          <label>Email</label>
          <input type="email" id="f-email" placeholder="user@exemplo.com">
        </div>
        <div class="form-group" style="max-width:180px">
          <label>Senha</label>
          <input type="text" id="f-senha" placeholder="Senha@2026!">
        </div>
        <div class="form-group" style="max-width:200px">
          <label>Contrato ID</label>
          <input type="text" id="f-contrato" placeholder="uuid ou —">
        </div>
        <div class="form-group" style="flex:2">
          <label>Casos de uso</label>
          <input type="text" id="f-casos" placeholder="adesão completa, rescisão...">
        </div>
        <div class="form-group" style="max-width:100px">
          <label>&nbsp;</label>
          <button class="btn btn-primary" onclick="addAccount()">+ Adicionar</button>
        </div>
      </div>
      <table id="accounts-table">
        <thead>
          <tr>
            <th>Email</th>
            <th>Senha</th>
            <th>Contrato ID</th>
            <th>Casos de uso</th>
            <th>Criado em</th>
            <th></th>
          </tr>
        </thead>
        <tbody id="tbody">
          ${accounts.length === 0
            ? '<tr><td colspan="6" class="empty">Nenhuma conta cadastrada ainda.</td></tr>'
            : accounts.map(a => `
          <tr data-id="${a.id}">
            <td class="mono">${a.email}</td>
            <td class="mono">${a.senha}</td>
            <td class="mono" style="max-width:160px;overflow:hidden;text-overflow:ellipsis">${a.contratoId || '—'}</td>
            <td>${(a.casos || []).map(c => `<span class="badge">${c}</span>`).join('')}</td>
            <td class="date">${new Date(a.createdAt).toLocaleDateString('pt-BR')}</td>
            <td class="actions">
              <button class="btn btn-danger btn-sm" onclick="deleteAccount('${a.id}')">Remover</button>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
  </div>
  <script>
    async function addAccount() {
      const email = document.getElementById('f-email').value.trim();
      const senha = document.getElementById('f-senha').value.trim();
      const contratoId = document.getElementById('f-contrato').value.trim();
      const casosRaw = document.getElementById('f-casos').value.trim();
      if (!email || !senha) { alert('Email e senha são obrigatórios'); return; }
      const casos = casosRaw ? casosRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
      const res = await fetch('/api/test-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, senha, contratoId, casos })
      });
      if (res.ok) location.reload();
      else alert('Erro ao adicionar conta');
    }
    async function deleteAccount(id) {
      if (!confirm('Remover esta conta?')) return;
      const res = await fetch('/api/test-accounts/' + id, { method: 'DELETE' });
      if (res.ok) location.reload();
      else alert('Erro ao remover conta');
    }
  </script>
</body>
</html>`);
});

app.get('/api/test-accounts', (_req, res) => {
  res.json(loadTestAccounts());
});

app.post('/api/test-accounts', (req, res) => {
  const { email, senha, contratoId, casos } = req.body || {};
  if (!email || !senha) return res.status(400).json({ error: 'email e senha obrigatórios' });
  const accounts = loadTestAccounts();
  const account = {
    id: crypto.randomUUID(),
    email,
    senha,
    contratoId: contratoId || null,
    casos: Array.isArray(casos) ? casos : [],
    createdAt: new Date().toISOString(),
  };
  accounts.push(account);
  saveTestAccounts(accounts);
  res.status(201).json(account);
});

app.put('/api/test-accounts/:id', (req, res) => {
  const accounts = loadTestAccounts();
  const idx = accounts.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  accounts[idx] = { ...accounts[idx], ...req.body, id: req.params.id };
  saveTestAccounts(accounts);
  res.json(accounts[idx]);
});

app.delete('/api/test-accounts/:id', (req, res) => {
  const accounts = loadTestAccounts();
  const filtered = accounts.filter(a => a.id !== req.params.id);
  if (filtered.length === accounts.length) return res.status(404).json({ error: 'not found' });
  saveTestAccounts(filtered);
  res.json({ ok: true });
});

// ===== public =====
app.get('/health', (_req, res) => {
  const active = [...db.prepare('SELECT COUNT(*) c FROM sessions WHERE status = ?').iterate('active')][0]?.c || 0;
  res.json({ ok: true, version: '0.1.0', activeSessions: active });
});

// Serve screenshots and runs assets (public, but unguessable paths)
app.use('/data', express.static(DATA_DIR));

// Serve the web UI (SPA at /app/*).
const APP_DIR = path.join(__dirname, '..', 'public', 'app');
app.use('/app', express.static(APP_DIR));
// SPA fallback — any /app/* path that isn't a static file returns index.html
app.get('/app/*', (_req, res) => res.sendFile(path.join(APP_DIR, 'index.html')));
// Root convenience
app.get('/', (_req, res) => res.redirect('/app/'));

// ===== auth (public endpoints) =====
//
// Signup is now 2-stage:
//   1) POST /auth/signup/start    { email, password, name } → emails OTP
//   2) POST /auth/signup/verify   { email, otp }            → creates user + token
//
// The legacy POST /auth/signup is kept as an alias of /signup/start for backwards
// compat; clients receive 202 Accepted with a hint to call /verify next.

app.post('/auth/signup/start', async (req, res) => {
  try {
    const { email: rawEmail, password, name } = req.body || {};
    if (!rawEmail || !password) return res.status(400).json({ error: 'email and password required' });
    if (String(password).length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
    if (!auth.isAllowedEmail(rawEmail)) {
      return res.status(403).json({ error: `signup is restricted to @${auth.ALLOWED_DOMAIN} emails` });
    }
    const lower = String(rawEmail).trim().toLowerCase();
    if (auth.findUserByEmail(lower)) return res.status(400).json({ error: 'email already registered. use /auth/login' });

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const otpHash = auth.hashToken(otp);
    const passwordHash = auth.hashPassword(password);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');

    db.prepare(`
      INSERT INTO pending_signups (email, password_hash, name, otp_hash, otp_attempts, expires_at, created_at)
      VALUES (?, ?, ?, ?, 0, ?, CURRENT_TIMESTAMP)
      ON CONFLICT (email) DO UPDATE SET
        password_hash = excluded.password_hash,
        name = excluded.name,
        otp_hash = excluded.otp_hash,
        otp_attempts = 0,
        expires_at = excluded.expires_at,
        created_at = CURRENT_TIMESTAMP
    `).run(lower, passwordHash, name || null, otpHash, expiresAt);

    try {
      await email.otpEmail({ to: lower, otp, name });
    } catch (e) {
      // If email sending fails, surface it (and roll back the pending row so retry is possible)
      db.prepare('DELETE FROM pending_signups WHERE email = ?').run(lower);
      return res.status(500).json({ error: `failed to send verification email: ${e.message}` });
    }

    res.json({ ok: true, expiresAt, next: '/auth/signup/verify' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/auth/signup/verify', (req, res) => {
  try {
    const { email: rawEmail, otp } = req.body || {};
    if (!rawEmail || !otp) return res.status(400).json({ error: 'email and otp required' });
    const lower = String(rawEmail).trim().toLowerCase();

    const pending = db.prepare('SELECT * FROM pending_signups WHERE email = ?').get(lower);
    if (!pending) return res.status(400).json({ error: 'no pending signup. start over with /auth/signup/start' });
    if (new Date(pending.expires_at) < new Date()) {
      db.prepare('DELETE FROM pending_signups WHERE email = ?').run(lower);
      return res.status(400).json({ error: 'code expired. start over' });
    }
    if (pending.otp_attempts >= 5) {
      db.prepare('DELETE FROM pending_signups WHERE email = ?').run(lower);
      return res.status(429).json({ error: 'too many failed attempts. start over' });
    }
    const givenHash = auth.hashToken(String(otp).trim());
    if (givenHash !== pending.otp_hash) {
      db.prepare('UPDATE pending_signups SET otp_attempts = otp_attempts + 1 WHERE email = ?').run(lower);
      return res.status(400).json({ error: 'invalid code' });
    }

    // Create the user (password is already hashed in pending row).
    const userId = auth.newId();
    db.prepare('INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, ?, ?)')
      .run(userId, lower, pending.password_hash, pending.name);

    // Auto-share with all existing projects (internal-mode)
    projects.autoShareUserWithAllProjects(userId);

    db.prepare('DELETE FROM pending_signups WHERE email = ?').run(lower);

    const user = auth.getUser(userId);
    const t = auth.issueToken({ userId: user.id, kind: 'session', name: 'cli-login', expiresInDays: 30 });
    res.status(201).json({ user, token: t.token, expiresAt: t.expiresAt });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Legacy alias (single-step signup) — now requires OTP, just routes to start.
app.post('/auth/signup', async (req, res) => {
  // delegate
  req.url = '/auth/signup/start';
  app._router.handle(req, res, () => {});
});

app.post('/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  const user = auth.authenticate(email, password);
  if (!user) return res.status(401).json({ error: 'invalid credentials' });
  const t = auth.issueToken({ userId: user.id, kind: 'session', name: 'cli-login', expiresInDays: 30 });
  res.json({ user, token: t.token, expiresAt: t.expiresAt });
});

app.post('/auth/logout', (req, res) => {
  const key = req.header('X-API-Key') || (req.header('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (key) auth.revokeTokenByValue(key);
  res.json({ ok: true });
});

// ===== authenticated user-scope endpoints =====
app.get('/auth/me', authMiddleware, (req, res) => {
  res.json({ user: { id: req.user.userId, email: req.user.email, name: req.user.name, source: req.user.source } });
});

app.get('/auth/tokens', authMiddleware, (req, res) => {
  if (req.user.userId === auth.SYSTEM_USER_ID) return res.status(400).json({ error: 'legacy API_KEYS user has no tokens' });
  const tokens = auth.listTokens(req.user.userId);
  res.json({ tokens });
});

app.post('/auth/tokens', authMiddleware, (req, res) => {
  if (req.user.userId === auth.SYSTEM_USER_ID) return res.status(400).json({ error: 'legacy user cannot create tokens — sign up first' });
  const { name, kind = 'api', expiresInDays } = req.body || {};
  const t = auth.issueToken({ userId: req.user.userId, kind, name: name || null, expiresInDays: expiresInDays || null });
  res.status(201).json({ token: t.token, id: t.id, prefix: t.prefix, name: name || null, expiresAt: t.expiresAt });
});

app.delete('/auth/tokens/:id', authMiddleware, (req, res) => {
  auth.revokeToken({ userId: req.user.userId, id: req.params.id });
  res.json({ ok: true });
});

app.get('/auth/usage', authMiddleware, (req, res) => {
  if (req.user.userId === auth.SYSTEM_USER_ID) return res.status(400).json({ error: 'legacy user' });
  const limit = parseInt(req.query.limit || '50', 10);
  const rows = db.prepare('SELECT id, project_id, action, details_json, created_at FROM usage_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(req.user.userId, limit);
  const totals = db.prepare('SELECT action, COUNT(*) as count FROM usage_log WHERE user_id = ? GROUP BY action').all(req.user.userId);
  res.json({ recent: rows, totals });
});

// ===== projects (auth required, no project-scope yet) =====
app.get('/projects', authMiddleware, (req, res) => {
  res.json({ projects: projects.listProjectsForUser(req.userId) });
});

/**
 * Cross-project health snapshot. One entry per project the user is a member of.
 * Metrics computed in a single pass per project so this stays cheap even with
 * lots of runs. The "open findings" count walks the latest 10 runs per project
 * and dedupes by signature, ignoring anything triaged not_a_bug / accepted_risk.
 */
app.get('/api/dashboard', authMiddleware, (req, res) => {
  const days = Math.max(1, Math.min(90, parseInt(req.query.days || '7', 10)));
  const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

  const myProjects = projects.listProjectsForUser(req.userId);
  const out = [];

  for (const p of myProjects) {
    const flowsCount = db.prepare('SELECT COUNT(*) c FROM flows WHERE project_id = ?').get(p.id).c;
    const schedulesCount = db.prepare('SELECT COUNT(*) c FROM scheduled_runs WHERE project_id = ? AND enabled = 1').get(p.id).c;
    const rulesCount = db.prepare('SELECT COUNT(*) c FROM suppression_rules WHERE project_id = ? AND enabled = 1').get(p.id).c;

    const runStats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'passed' THEN 1 ELSE 0 END) as passed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM runs WHERE project_id = ? AND started_at >= ?
    `).get(p.id, sinceIso);

    const passRate = runStats.total > 0 ? Math.round((runStats.passed / runStats.total) * 100) : null;

    // Latest failure (any time, not just within window — gives "most recent breakage")
    const lastFailure = db.prepare(`
      SELECT id, flow_id, flow_name, started_at, error
        FROM runs WHERE project_id = ? AND status = 'failed'
        ORDER BY started_at DESC LIMIT 1
    `).get(p.id);

    // Open findings: walk latest 10 runs, gather unique signatures, count those
    // whose triage status is anything other than not_a_bug / accepted_risk.
    const recentRuns = db.prepare('SELECT result_json FROM runs WHERE project_id = ? ORDER BY started_at DESC LIMIT 10').all(p.id);
    const sigSet = new Set();
    const sigInfo = new Map();
    for (const rr of recentRuns) {
      const result = rr.result_json ? safeParse(rr.result_json) : null;
      if (!result?.steps) continue;
      for (const s of result.steps) for (const f of (s.findings || [])) {
        if (!sigSet.has(f.signature)) {
          sigSet.add(f.signature);
          sigInfo.set(f.signature, f.severity);
        }
      }
    }
    let openCount = 0;
    let openHigh = 0;
    if (sigSet.size > 0) {
      const placeholders = Array.from(sigSet).map(() => '?').join(',');
      const triages = db.prepare(`SELECT finding_signature, status FROM finding_triage WHERE project_id = ? AND finding_signature IN (${placeholders})`).all(p.id, ...sigSet);
      const tMap = new Map(triages.map(t => [t.finding_signature, t.status]));
      for (const sig of sigSet) {
        const status = tMap.get(sig);
        if (status === 'not_a_bug' || status === 'accepted_risk') continue;
        openCount++;
        if (sigInfo.get(sig) === 'high') openHigh++;
      }
    }

    out.push({
      project: { id: p.id, slug: p.slug, name: p.name, role: p.role },
      metrics: {
        flows: flowsCount,
        schedules: schedulesCount,
        rules: rulesCount,
        runs: runStats.total,
        passed: runStats.passed,
        failed: runStats.failed,
        pass_rate: passRate,
        open_findings: openCount,
        open_high: openHigh,
        last_failure: lastFailure ? {
          run_id: lastFailure.id,
          flow_id: lastFailure.flow_id,
          flow_name: lastFailure.flow_name,
          started_at: lastFailure.started_at,
          error: (lastFailure.error || '').slice(0, 200),
        } : null,
      },
    });
  }
  res.json({ projects: out, window_days: days });
});

app.post('/projects', authMiddleware, (req, res) => {
  try {
    const { name, slug, description } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    const p = projects.createProject({ name, slug, description, ownerId: req.userId });
    res.status(201).json({ project: { ...p, role: 'owner' } });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/projects/:slug', authMiddleware, (req, res) => {
  const p = projects.getProjectBySlug(req.params.slug);
  if (!p) return res.status(404).json({ error: 'project not found' });
  const m = projects.getMembership(p.id, req.userId);
  if (!m) return res.status(403).json({ error: 'not a member' });
  res.json({ project: { ...p, role: m.role }, members: projects.listMembers(p.id) });
});

app.delete('/projects/:slug', authMiddleware, (req, res) => {
  const p = projects.getProjectBySlug(req.params.slug);
  if (!p) return res.status(404).json({ error: 'project not found' });
  const m = projects.getMembership(p.id, req.userId);
  if (!m || m.role !== 'owner') return res.status(403).json({ error: 'owner only' });
  db.prepare('DELETE FROM projects WHERE id = ?').run(p.id);
  res.json({ ok: true });
});

app.patch('/projects/:slug', authMiddleware, (req, res) => {
  const p = projects.getProjectBySlug(req.params.slug);
  if (!p) return res.status(404).json({ error: 'project not found' });
  const m = projects.getMembership(p.id, req.userId);
  if (!m || (m.role !== 'owner' && m.role !== 'admin')) return res.status(403).json({ error: 'owner/admin only' });

  const { name, description, context_md } = req.body || {};
  const updates = []; const args = [];
  if (name !== undefined)        { updates.push('name = ?');        args.push(name); }
  if (description !== undefined) { updates.push('description = ?'); args.push(description); }
  if (context_md !== undefined)  {
    // Cap at 16KB so a runaway markdown blob doesn't bloat the LLM prompt
    if (typeof context_md !== 'string') return res.status(400).json({ error: 'context_md must be a string' });
    if (context_md.length > 16 * 1024) return res.status(400).json({ error: 'context_md too long (max 16KB)' });
    updates.push('context_md = ?'); args.push(context_md || null);
  }
  if (updates.length === 0) return res.json({ ok: true, noop: true });
  args.push(p.id);
  db.prepare(`UPDATE projects SET ${updates.join(', ')} WHERE id = ?`).run(...args);
  res.json({ ok: true });
});

app.get('/projects/:slug/invites', authMiddleware, (req, res) => {
  const p = projects.getProjectBySlug(req.params.slug);
  if (!p) return res.status(404).json({ error: 'project not found' });
  const m = projects.getMembership(p.id, req.userId);
  if (!m || projects.ROLE_RANK[m.role] < projects.ROLE_RANK.admin) return res.status(403).json({ error: 'admin+ required' });
  res.json({ invites: projects.listInvites(p.id) });
});

app.post('/projects/:slug/invites', authMiddleware, (req, res) => {
  const p = projects.getProjectBySlug(req.params.slug);
  if (!p) return res.status(404).json({ error: 'project not found' });
  const m = projects.getMembership(p.id, req.userId);
  if (!m || projects.ROLE_RANK[m.role] < projects.ROLE_RANK.admin) return res.status(403).json({ error: 'admin+ required' });
  try {
    const { role = 'editor', expiresInDays = 14 } = req.body || {};
    const inv = projects.createInvite({ projectId: p.id, role, createdBy: req.userId, expiresInDays });
    res.status(201).json(inv);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/projects/:slug/invites/:id', authMiddleware, (req, res) => {
  const p = projects.getProjectBySlug(req.params.slug);
  if (!p) return res.status(404).json({ error: 'project not found' });
  const m = projects.getMembership(p.id, req.userId);
  if (!m || projects.ROLE_RANK[m.role] < projects.ROLE_RANK.admin) return res.status(403).json({ error: 'admin+ required' });
  projects.revokeInvite({ projectId: p.id, id: req.params.id });
  res.json({ ok: true });
});

app.post('/projects/:slug/members/:userId/role', authMiddleware, (req, res) => {
  const p = projects.getProjectBySlug(req.params.slug);
  if (!p) return res.status(404).json({ error: 'project not found' });
  const m = projects.getMembership(p.id, req.userId);
  if (!m || projects.ROLE_RANK[m.role] < projects.ROLE_RANK.admin) return res.status(403).json({ error: 'admin+ required' });
  try { projects.setRole({ projectId: p.id, userId: req.params.userId, role: req.body?.role }); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/projects/:slug/members/:userId', authMiddleware, (req, res) => {
  const p = projects.getProjectBySlug(req.params.slug);
  if (!p) return res.status(404).json({ error: 'project not found' });
  const m = projects.getMembership(p.id, req.userId);
  if (!m || projects.ROLE_RANK[m.role] < projects.ROLE_RANK.admin) return res.status(403).json({ error: 'admin+ required' });
  if (req.params.userId === p.owner_id) return res.status(400).json({ error: "can't remove the owner" });
  projects.removeMember({ projectId: p.id, userId: req.params.userId });
  res.json({ ok: true });
});

app.post('/invites/redeem', authMiddleware, (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: 'code required' });
    const proj = projects.redeemInvite({ code: String(code).trim().toUpperCase(), userId: req.userId });
    res.json({ project: { ...proj, role: projects.getMembership(proj.id, req.userId)?.role } });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Public run viewer (HTML) — runId is unguessable hex, no auth needed
app.get('/runs/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).type('html').send('<h1>run not found</h1>');
  const result = row.result_json ? JSON.parse(row.result_json) : { steps: [] };
  const vars = row.vars_json ? JSON.parse(row.vars_json) : {};
  const steps = result.steps || [];
  const assertions = result.assertions || [];
  const statusColor = row.status === 'passed' ? '#10b981' : row.status === 'failed' ? '#ef4444' : '#f59e0b';

  // Hydrate findings with cross-run triage state for this run's project so the
  // public viewer reflects what the team has decided about each finding.
  enrichFindings(result, row.project_id);

  const SEV_W = { high: 3, medium: 2, low: 1 };
  const sevColor = (sev) => sev === 'high' ? '#ef4444' : sev === 'medium' ? '#f59e0b' : '#6b7280';
  const topSev = (findings) => {
    let best = null, w = 0;
    for (const f of findings || []) {
      const fw = SEV_W[f.severity] || 0;
      if (fw > w) { w = fw; best = f.severity; }
    }
    return best;
  };

  // Aggregate findings counts for the summary row.
  const allFindings = [];
  for (const s of steps) for (const f of (s.findings || [])) allFindings.push(f);
  const sevCount = { high: 0, medium: 0, low: 0 };
  for (const f of allFindings) sevCount[f.severity] = (sevCount[f.severity] || 0) + 1;

  // Pre-fetch http_calls + audit_entries para esta run, agrupados por step_n
  const httpCallsByStep = {};
  const auditEntriesByStep = {};
  try {
    const calls = db.prepare(
      `SELECT id, step_n, method, url, response_status, latency_ms, error,
              request_headers, request_body, response_headers, response_body, trace_id
       FROM http_calls WHERE run_id = ? ORDER BY id ASC`
    ).all(req.params.id);
    for (const c of calls) {
      const k = String(c.step_n);
      (httpCallsByStep[k] = httpCallsByStep[k] || []).push(c);
    }
    const audits = db.prepare(
      `SELECT id, step_n, trace_id, action, http_status, status, latency_ms, user_id, raw_json
       FROM audit_entries WHERE run_id = ? ORDER BY id ASC`
    ).all(req.params.id);
    for (const a of audits) {
      const k = String(a.step_n);
      (auditEntriesByStep[k] = auditEntriesByStep[k] || []).push(a);
    }
  } catch {}

  // Helpers para expandir detalhes (com redaction de auth)
  const redactHeaders = (raw) => {
    if (!raw) return '';
    let obj;
    try { obj = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return String(raw); }
    if (obj && typeof obj === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        out[k] = /^(authorization|apikey|x-api-key|cookie|x-trace-id)$/i.test(k)
          ? (typeof v === 'string' ? v.slice(0, 16) + '…<redacted>' : '<redacted>')
          : v;
      }
      return JSON.stringify(out, null, 2);
    }
    return String(raw);
  };
  const formatBody = (raw) => {
    if (raw == null || raw === '') return '<empty>';
    const s = String(raw);
    try {
      const parsed = JSON.parse(s);
      const pretty = JSON.stringify(parsed, null, 2);
      return pretty.length > 8000 ? pretty.slice(0, 8000) + '\n…(truncated)' : pretty;
    } catch {
      return s.length > 4000 ? s.slice(0, 4000) + '\n…(truncated)' : s;
    }
  };

  const findingsSummaryHtml = allFindings.length === 0 ? '' : `
    <div class="findings-summary">
      <span class="summary-label">findings:</span>
      <span class="pill all">all <b>${allFindings.length}</b></span>
      ${sevCount.high   ? `<span class="pill" style="color:#ef4444">high <b>${sevCount.high}</b></span>` : ''}
      ${sevCount.medium ? `<span class="pill" style="color:#f59e0b">medium <b>${sevCount.medium}</b></span>` : ''}
      ${sevCount.low    ? `<span class="pill" style="color:#6b7280">low <b>${sevCount.low}</b></span>`    : ''}
    </div>
  `;

  const stepHtml = steps.map(s => {
    const findings = s.findings || [];
    const top = topSev(findings);
    const sevBorder = top ? `border-left:4px solid ${sevColor(top)};` : '';
    const shot = s.screenshot ? `<img src="/data/${s.screenshot}" alt="step ${s.n}" loading="lazy"/>` : '';
    const okIcon = s.ok ? '✅' : '❌';
    const err = s.error ? `<div class="err">${escapeHtml(s.error)}</div>` : '';
    const valueLine = s.var ? `<div class="meta">${escapeHtml(s.var)} = <code>${escapeHtml(String(s.value ?? ''))}</code></div>` : '';

    const findingsHtml = findings.length === 0 ? '' : `
      <div class="findings">
        ${findings.map(f => {
          const triagedClass = f.triage ? `triaged-${f.triage.status}` : '';
          const triageBadge = f.triage
            ? `<span class="triage-badge triage-${f.triage.status}" title="${escapeHtml(f.triage.reason || '')}">${escapeHtml(f.triage.status.replace(/_/g, ' '))}</span>`
            : '';
          const notesBadge = f.notes_count ? `<span class="notes-count" title="${f.notes_count} internal notes">💬 ${f.notes_count}</span>` : '';
          const evidence = f.evidence ? `<details class="evidence"><summary>evidence</summary><pre>${escapeHtml(JSON.stringify(f.evidence, null, 2))}</pre></details>` : '';
          return `
            <div class="finding ${triagedClass}" style="border-left:3px solid ${sevColor(f.severity)};">
              <div class="finding-hd">
                <span class="sev sev-${f.severity}">${f.severity}</span>
                <span class="ftype">${escapeHtml(f.type)}</span>
                ${triageBadge}
                ${notesBadge}
                <code class="fsig">${escapeHtml(f.signature)}</code>
              </div>
              <div class="fmsg">${escapeHtml(f.msg)}</div>
              ${evidence}
            </div>
          `;
        }).join('')}
      </div>
    `;

    // Inline render http_calls + audit_entries do step
    const stepKey = String(s.n);
    const calls = httpCallsByStep[stepKey] || [];
    const audits = auditEntriesByStep[stepKey] || [];
    const httpHtml = calls.length === 0 ? '' : calls.map(c => {
      const status = c.response_status;
      const klass = status >= 200 && status < 300 ? 'ok' : status >= 400 ? 'fail' : 'warn';
      const shortUrl = (c.url || '').replace(/^https?:\/\/[^/]+/, '');
      return `<details class="http-call http-${klass}">
        <summary>
          <span class="hc-method">${escapeHtml(c.method)}</span>
          <code class="hc-url">${escapeHtml(shortUrl)}</code>
          <span class="hc-status hc-${klass}">${escapeHtml(String(status ?? '—'))}</span>
          <span class="hc-lat">${c.latency_ms}ms</span>
          ${c.error ? `<span class="hc-err">${escapeHtml(c.error)}</span>` : ''}
        </summary>
        <div class="hc-body">
          <div class="hc-section"><b>request URL</b><pre>${escapeHtml(c.url || '')}</pre></div>
          ${c.trace_id ? `<div class="hc-section"><b>trace_id</b><pre>${escapeHtml(c.trace_id)}</pre></div>` : ''}
          <div class="hc-section"><b>request headers</b><pre>${escapeHtml(redactHeaders(c.request_headers))}</pre></div>
          <div class="hc-section"><b>request body</b><pre>${escapeHtml(formatBody(c.request_body))}</pre></div>
          <div class="hc-section"><b>response headers</b><pre>${escapeHtml(redactHeaders(c.response_headers))}</pre></div>
          <div class="hc-section"><b>response body</b><pre>${escapeHtml(formatBody(c.response_body))}</pre></div>
        </div>
      </details>`;
    }).join('');
    const auditHtml = audits.length === 0 ? '' : audits.map(a => {
      const klass = a.status === 'success' ? 'ok' : 'fail';
      return `<details class="audit-entry audit-${klass}">
        <summary>
          <span class="ae-arrow">↳ audit</span>
          <code class="ae-action">${escapeHtml(a.action || '')}</code>
          <span class="ae-status ae-${klass}">${escapeHtml(String(a.http_status ?? '—'))}</span>
          <span class="ae-lat">${a.latency_ms}ms</span>
          ${a.user_id ? `<span class="ae-user">user <code>${escapeHtml(String(a.user_id).slice(0, 8))}</code></span>` : ''}
        </summary>
        <div class="ae-body">
          <div class="hc-section"><b>trace_id</b><pre>${escapeHtml(a.trace_id || '')}</pre></div>
          <div class="hc-section"><b>audit_log row</b><pre>${escapeHtml(formatBody(a.raw_json))}</pre></div>
        </div>
      </details>`;
    }).join('');

    return `<div class="step ${s.ok ? 'ok' : 'fail'}" style="${sevBorder}">
      <div class="hd"><b>${okIcon} ${s.n}. ${escapeHtml(s.action)}</b><span class="dur">${s.durationMs}ms</span></div>
      ${valueLine}${err}${httpHtml}${auditHtml}${findingsHtml}${shot}
    </div>`;
  }).join('');

  const assertHtml = assertions.length ? `<h3>assertions</h3>` + assertions.map(a =>
    `<div class="assert ${a.passed ? 'ok' : 'fail'}">${a.passed ? '✅' : '❌'} <code>${escapeHtml(JSON.stringify(a))}</code></div>`
  ).join('') : '';

  const varsHtml = Object.keys(vars).length ? `<h3>vars</h3><pre>${escapeHtml(JSON.stringify(vars, null, 2))}</pre>` : '';

  res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"/><title>run ${row.id} — ${escapeHtml(row.flow_name || '')}</title>
<style>
  body{font-family:system-ui,sans-serif;background:#0b0b0c;color:#e5e7eb;margin:0;padding:24px;max-width:980px;margin:0 auto}
  h1{margin:0 0 4px}
  .sub{color:#9ca3af;font-size:14px;margin-bottom:16px}
  .badge{display:inline-block;padding:3px 10px;border-radius:999px;color:#fff;font-size:12px;font-weight:600;background:${statusColor}}
  .step{background:#171719;border:1px solid #27272a;border-radius:8px;padding:12px;margin:10px 0;border-left-width:4px}
  .step.fail{border-color:#7f1d1d}
  .hd{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
  .dur{color:#9ca3af;font-size:12px}
  .meta{color:#9ca3af;font-size:13px;margin:4px 0}
  .err{color:#fca5a5;background:#1f0a0a;padding:8px;border-radius:6px;font-family:monospace;font-size:13px;margin:6px 0}
  img{max-width:100%;border-radius:6px;margin-top:8px;border:1px solid #27272a}
  pre{background:#171719;border:1px solid #27272a;border-radius:6px;padding:12px;overflow:auto;font-size:13px}
  code{background:#27272a;padding:1px 5px;border-radius:3px;font-size:12px}
  .assert{padding:6px 10px;background:#171719;border-radius:6px;margin:4px 0;font-size:13px}
  .assert.fail{background:#1f0a0a}
  a{color:#60a5fa}

  .findings-summary{display:flex;gap:6px;flex-wrap:wrap;align-items:center;padding:8px 12px;background:#171719;border:1px solid #27272a;border-radius:8px;margin:10px 0 16px}
  .summary-label{font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-right:4px}
  .pill{display:inline-flex;align-items:center;gap:4px;font-size:12px;padding:2px 10px;background:#1a1a1f;border:1px solid #27272a;border-radius:999px;color:#9ca3af}
  .pill.all{color:#e5e7eb}
  .pill b{font-variant-numeric:tabular-nums}

  .findings{display:flex;flex-direction:column;gap:6px;margin-top:8px}
  .finding{padding:8px 10px;background:#1a1a1f;border:1px solid #27272a;border-radius:6px;font-size:12px}
  .finding.triaged-not_a_bug,.finding.triaged-accepted_risk{opacity:0.55}
  .finding-hd{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px}
  .sev{font-size:10px;text-transform:uppercase;letter-spacing:0.05em;padding:1px 6px;border-radius:3px;font-weight:600}
  .sev-high{background:rgba(239,68,68,0.15);color:#ef4444}
  .sev-medium{background:rgba(245,158,11,0.15);color:#f59e0b}
  .sev-low{background:rgba(107,114,128,0.2);color:#9ca3af}
  .ftype{font-family:ui-monospace,monospace;font-size:11px;color:#9ca3af}
  .fsig{font-size:10px;color:#6b7280;margin-left:auto}
  .fmsg{color:#e5e7eb;line-height:1.4}
  .triage-badge{font-size:10px;padding:1px 8px;border-radius:3px;font-weight:600;text-transform:uppercase;letter-spacing:0.03em}
  .triage-bug{background:rgba(239,68,68,0.15);color:#ef4444}

  .http-call,.audit-entry{font-family:ui-monospace,monospace;font-size:12px;background:#0d0d12;border-radius:4px;margin-top:4px;border-left:3px solid #3b82f6}
  .audit-entry{margin-left:18px;border-left:2px dashed #6b7280;background:#0a0a0d}
  .http-call > summary,.audit-entry > summary{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:5px 10px;cursor:pointer;list-style:none;outline:none}
  .http-call > summary::-webkit-details-marker,.audit-entry > summary::-webkit-details-marker{display:none}
  .http-call > summary::before,.audit-entry > summary::before{content:'▸';color:#6b7280;font-size:10px;margin-right:2px;transition:transform 0.15s}
  .http-call[open] > summary::before,.audit-entry[open] > summary::before{transform:rotate(90deg)}
  .http-call > summary:hover,.audit-entry > summary:hover{background:#15151b}
  .hc-method{font-weight:700;color:#60a5fa;min-width:46px}
  .hc-url{color:#e5e7eb;background:transparent;padding:0;flex:1;min-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .hc-status,.ae-status{padding:1px 7px;border-radius:3px;font-weight:600}
  .hc-ok,.ae-ok{background:rgba(16,185,129,0.18);color:#10b981}
  .hc-fail,.ae-fail{background:rgba(239,68,68,0.18);color:#ef4444}
  .hc-warn{background:rgba(245,158,11,0.18);color:#f59e0b}
  .hc-lat,.ae-lat{color:#9ca3af;font-size:11px}
  .hc-err{color:#fca5a5;font-size:11px}
  .ae-arrow{color:#6b7280;font-size:11px}
  .ae-action{color:#a5b4fc;background:transparent;padding:0}
  .ae-user{color:#9ca3af;font-size:11px}
  .hc-body,.ae-body{padding:8px 14px 12px;border-top:1px solid #1f1f25}
  .hc-section{margin:8px 0}
  .hc-section > b{display:block;font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:3px;font-weight:600}
  .hc-section > pre{margin:0;background:#070709;border:1px solid #1f1f25;padding:8px 10px;font-size:11px;line-height:1.5;max-height:400px;overflow:auto}
  .triage-not_a_bug{background:rgba(107,114,128,0.2);color:#9ca3af}
  .triage-investigating{background:rgba(245,158,11,0.15);color:#f59e0b}
  .triage-accepted_risk{background:rgba(167,139,250,0.15);color:#a78bfa}
  .notes-count{font-size:11px;color:#9ca3af}
  .evidence{margin-top:6px;font-size:11px}
  .evidence summary{color:#6b7280;cursor:pointer}
  .evidence pre{margin:6px 0 0;padding:8px;font-size:11px;max-height:240px}
</style></head><body>
<h1>${escapeHtml(row.flow_name || row.flow_id)}</h1>
<div class="sub">
  <span class="badge">${row.status}</span>
  &middot; run <code>${row.id}</code>
  &middot; flow <code>${escapeHtml(row.flow_id)}</code>
  &middot; <span title="${escapeHtml(row.started_at)} UTC">${escapeHtml(fmtSP(row.started_at))}</span>${row.finished_at ? ` → <span title="${escapeHtml(row.finished_at)} UTC">${escapeHtml(fmtSP(row.finished_at))}</span> (BRT)` : ''}
</div>
${row.error ? `<div class="err">${escapeHtml(row.error)}</div>` : ''}
${findingsSummaryHtml}
${varsHtml}
<h3>steps (${steps.length})</h3>
${stepHtml}
${assertHtml}
</body></html>`);
});

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// SQLite stores timestamps as UTC. Render in America/São_Paulo for the team.
function fmtSP(s) {
  if (!s) return '';
  const d = new Date(String(s).replace(' ', 'T') + (String(s).includes('T') ? '' : 'Z'));
  if (isNaN(d.getTime())) return s;
  return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour12: false });
}

// ===== authenticated =====
app.use('/api', authMiddleware);

/**
 * Resolve project context for /api/* routes.
 * Order: X-Project header → ?project= query → legacy default for system → user's first project.
 * Sets req.project + req.role.
 */
app.use('/api', (req, res, next) => {
  let slug = req.header('X-Project') || req.query.project;
  if (!slug && req.userId === auth.SYSTEM_USER_ID) slug = 'hub-portal';
  if (!slug) {
    const first = db.prepare(`
      SELECT p.slug FROM projects p
      JOIN project_members m ON m.project_id = p.id
      WHERE m.user_id = ? ORDER BY p.created_at ASC LIMIT 1
    `).get(req.userId);
    slug = first?.slug;
  }
  if (!slug) return res.status(400).json({ error: 'no project context. set X-Project header, or join a project first (POST /invites/redeem).' });
  const project = db.prepare(`
    SELECT p.*, m.role FROM projects p
    JOIN project_members m ON m.project_id = p.id
    WHERE p.slug = ? AND m.user_id = ?
  `).get(slug, req.userId);
  if (!project) return res.status(403).json({ error: `not a member of project "${slug}"` });
  req.project = project;
  req.role = project.role;
  res.set('X-Project-Resolved', project.slug);
  next();
});

const ROLE_RANK = projects.ROLE_RANK;
const requireRole = (min) => (req, res, next) => {
  if (ROLE_RANK[req.role] < ROLE_RANK[min]) return res.status(403).json({ error: `requires role ${min}+, you are ${req.role}` });
  next();
};

// ----- project vars (credentials/constants store) -----
app.get('/api/project-vars', (req, res) => {
  const reveal = req.query.reveal === 'true' && (req.role === 'owner' || req.role === 'admin');
  res.json({ vars: projects.listVars(req.project.id, { revealSecrets: reveal }) });
});

app.put('/api/project-vars/:name', requireRole('editor'), (req, res) => {
  try {
    const { value, is_secret = false, description } = req.body || {};
    if (value === undefined || value === null) return res.status(400).json({ error: 'value required' });
    projects.setVar({
      projectId: req.project.id,
      name: req.params.name,
      value: String(value),
      isSecret: !!is_secret,
      description: description || null,
      updatedBy: req.userId,
    });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/project-vars/:name', requireRole('editor'), (req, res) => {
  projects.unsetVar({ projectId: req.project.id, name: req.params.name });
  res.json({ ok: true });
});

// ----- scheduled runs -----
app.get('/api/schedules', (req, res) => {
  const rows = db.prepare(`
    SELECT s.id, s.flow_id, s.name, s.cron_expr, s.enabled, s.vars_json,
           s.last_fired_at, s.last_run_id, s.last_status, s.last_error, s.created_at,
           f.name as flow_name
      FROM scheduled_runs s
      LEFT JOIN flows f ON f.id = s.flow_id
     WHERE s.project_id = ?
     ORDER BY s.created_at DESC
  `).all(req.project.id);
  // Compute next firing client-side from cron_expr — but doing it here once is
  // cheaper and saves the front-end from needing the cron lib.
  const now = new Date();
  for (const r of rows) {
    try { r.next_fire = cron.nextFiring(r.cron_expr, now)?.toISOString() || null; }
    catch { r.next_fire = null; }
    r.vars = r.vars_json ? safeParse(r.vars_json) : {};
    delete r.vars_json;
  }
  res.json({ schedules: rows });
});

app.post('/api/schedules', requireRole('editor'), (req, res) => {
  const { flow_id, name, cron_expr, enabled, vars } = req.body || {};
  if (!flow_id || !cron_expr) return res.status(400).json({ error: 'flow_id and cron_expr required' });

  // Validate flow belongs to this project
  const flow = db.prepare('SELECT id FROM flows WHERE id = ? AND project_id = ?').get(flow_id, req.project.id);
  if (!flow) return res.status(404).json({ error: 'flow not found in this project' });

  // Validate cron syntax up front so we don't store garbage
  try { cron.parse(cron_expr); }
  catch (e) { return res.status(400).json({ error: 'invalid cron: ' + e.message }); }

  const id = crypto.randomBytes(8).toString('hex');
  db.prepare(`
    INSERT INTO scheduled_runs (id, project_id, flow_id, name, cron_expr, enabled, vars_json, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.project.id, flow_id, name || null, cron_expr, enabled === false ? 0 : 1,
       vars ? JSON.stringify(vars) : null, req.userId);
  res.status(201).json({ id });
});

app.patch('/api/schedules/:id', requireRole('editor'), (req, res) => {
  const sched = db.prepare('SELECT id FROM scheduled_runs WHERE id = ? AND project_id = ?').get(req.params.id, req.project.id);
  if (!sched) return res.status(404).json({ error: 'schedule not found' });

  const updates = [];
  const args = [];
  const { name, cron_expr, enabled, vars } = req.body || {};
  if (name !== undefined)      { updates.push('name = ?');      args.push(name || null); }
  if (cron_expr !== undefined) {
    try { cron.parse(cron_expr); }
    catch (e) { return res.status(400).json({ error: 'invalid cron: ' + e.message }); }
    updates.push('cron_expr = ?'); args.push(cron_expr);
  }
  if (enabled !== undefined)   { updates.push('enabled = ?');   args.push(enabled ? 1 : 0); }
  if (vars !== undefined)      { updates.push('vars_json = ?'); args.push(vars ? JSON.stringify(vars) : null); }
  if (updates.length === 0) return res.json({ ok: true, noop: true });
  args.push(req.params.id);
  db.prepare(`UPDATE scheduled_runs SET ${updates.join(', ')} WHERE id = ?`).run(...args);
  res.json({ ok: true });
});

app.delete('/api/schedules/:id', requireRole('editor'), (req, res) => {
  const r = db.prepare('DELETE FROM scheduled_runs WHERE id = ? AND project_id = ?').run(req.params.id, req.project.id);
  if (r.changes === 0) return res.status(404).json({ error: 'schedule not found' });
  res.json({ ok: true });
});

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }

// ----- suppression rules -----
const rules = require('./rules');

app.get('/api/suppression-rules', (req, res) => {
  const rows = db.prepare(`
    SELECT id, name, description, expr_json, enabled, created_by, created_at
      FROM suppression_rules WHERE project_id = ? ORDER BY created_at DESC
  `).all(req.project.id);
  // Count how often each rule has actually fired so the UI can show usefulness.
  const counts = db.prepare(`SELECT rule_id, COUNT(*) as c FROM finding_triage WHERE project_id = ? AND rule_id IS NOT NULL GROUP BY rule_id`).all(req.project.id);
  const cMap = new Map(counts.map(r => [r.rule_id, r.c]));
  for (const r of rows) {
    r.match_count = cMap.get(r.id) || 0;
    try { r.expr = JSON.parse(r.expr_json); } catch { r.expr = null; r.expr_invalid = true; }
    delete r.expr_json;
  }
  res.json({ rules: rows });
});

app.post('/api/suppression-rules', requireRole('admin'), (req, res) => {
  const { name, description, expr, enabled } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  let parsed;
  try { parsed = rules.parseExpr(expr); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  const id = crypto.randomBytes(8).toString('hex');
  db.prepare(`
    INSERT INTO suppression_rules (id, project_id, name, description, expr_json, enabled, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.project.id, name, description || null, JSON.stringify(parsed), enabled === false ? 0 : 1, req.userId);
  res.status(201).json({ id });
});

app.patch('/api/suppression-rules/:id', requireRole('admin'), (req, res) => {
  const row = db.prepare('SELECT id FROM suppression_rules WHERE id = ? AND project_id = ?').get(req.params.id, req.project.id);
  if (!row) return res.status(404).json({ error: 'rule not found' });

  const updates = []; const args = [];
  const { name, description, expr, enabled } = req.body || {};
  if (name !== undefined)        { updates.push('name = ?');        args.push(name); }
  if (description !== undefined) { updates.push('description = ?'); args.push(description || null); }
  if (expr !== undefined) {
    let parsed;
    try { parsed = rules.parseExpr(expr); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    updates.push('expr_json = ?'); args.push(JSON.stringify(parsed));
  }
  if (enabled !== undefined)     { updates.push('enabled = ?');     args.push(enabled ? 1 : 0); }
  if (updates.length === 0) return res.json({ ok: true, noop: true });
  args.push(req.params.id);
  db.prepare(`UPDATE suppression_rules SET ${updates.join(', ')} WHERE id = ?`).run(...args);
  res.json({ ok: true });
});

app.delete('/api/suppression-rules/:id', requireRole('admin'), (req, res) => {
  const r = db.prepare('DELETE FROM suppression_rules WHERE id = ? AND project_id = ?').run(req.params.id, req.project.id);
  if (r.changes === 0) return res.status(404).json({ error: 'rule not found' });
  // Also clear any triage rows that this rule had created so they re-surface
  // until a new rule (or human) handles them again.
  db.prepare(`DELETE FROM finding_triage WHERE project_id = ? AND rule_id = ?`).run(req.project.id, req.params.id);
  res.json({ ok: true });
});

/**
 * Mine recent runs for findings that humans repeatedly mark "not_a_bug"
 * and propose a single suppression-rule expr that would cover the group.
 *
 * Heuristic: walk recent runs, find each unique signature that's manually
 * triaged as not_a_bug, then find that signature's finding payload (latest
 * occurrence wins). Group by `type`, then by (type + evidence.status) when
 * the latter is consistent across the group. A group of size ≥ 3 becomes
 * a suggestion.
 */
app.get('/api/rule-suggestions', (req, res) => {
  const projectId = req.project.id;

  // signatures that humans have suppressed
  const suppressed = db.prepare(`
    SELECT finding_signature, reason FROM finding_triage
    WHERE project_id = ? AND status = 'not_a_bug' AND (triaged_by IS NULL OR triaged_by != 'rule')
  `).all(projectId);
  if (suppressed.length === 0) return res.json({ suggestions: [] });

  const sigSet = new Set(suppressed.map(s => s.finding_signature));

  // Walk recent runs to find an example of each signature
  const recent = db.prepare(`SELECT id, result_json FROM runs WHERE project_id = ? ORDER BY started_at DESC LIMIT 50`).all(projectId);
  const exemplars = new Map(); // signature -> first-seen finding object
  for (const r of recent) {
    if (sigSet.size === 0) break;
    const result = r.result_json ? safeParse(r.result_json) : null;
    if (!result?.steps) continue;
    for (const s of result.steps) for (const f of (s.findings || [])) {
      if (sigSet.has(f.signature) && !exemplars.has(f.signature)) {
        exemplars.set(f.signature, f);
        sigSet.delete(f.signature);
      }
    }
  }

  // Group exemplars by (type) and (type + evidence.status)
  const byType = new Map();
  const byTypeStatus = new Map();
  for (const f of exemplars.values()) {
    if (!byType.has(f.type)) byType.set(f.type, []);
    byType.get(f.type).push(f);
    const status = f.evidence?.status;
    if (status !== undefined && status !== null) {
      const key = f.type + ':' + status;
      if (!byTypeStatus.has(key)) byTypeStatus.set(key, []);
      byTypeStatus.get(key).push(f);
    }
  }

  // Don't re-suggest patterns already covered by an existing rule
  const existing = db.prepare(`SELECT expr_json FROM suppression_rules WHERE project_id = ? AND enabled = 1`).all(projectId);
  const existingExprs = existing.map(r => safeParse(r.expr_json));

  const suggestions = [];
  // (type + evidence.status) suggestions are more specific — try them first
  for (const [key, group] of byTypeStatus) {
    if (group.length < 3) continue;
    const [type, statusStr] = key.split(':');
    const status = Number(statusStr);
    const expr = { type, 'evidence.status': Number.isFinite(status) ? status : statusStr };
    if (existingExprs.some(e => sameKeys(e, expr))) continue;
    suggestions.push({
      kind: 'type_status',
      count: group.length,
      sample_msg: group[0].msg?.slice(0, 200) || '',
      suggested_name: `auto-suppress ${type} ${statusStr}`,
      suggested_expr: expr,
      signatures: group.map(g => g.signature),
    });
  }
  // Pure-type suggestions only when not already covered
  for (const [type, group] of byType) {
    if (group.length < 3) continue;
    const expr = { type };
    if (existingExprs.some(e => sameKeys(e, expr))) continue;
    if (suggestions.some(s => s.suggested_expr.type === type)) continue;
    suggestions.push({
      kind: 'type',
      count: group.length,
      sample_msg: group[0].msg?.slice(0, 200) || '',
      suggested_name: `auto-suppress ${type}`,
      suggested_expr: expr,
      signatures: group.map(g => g.signature),
    });
  }

  res.json({ suggestions });
});

function sameKeys(a, b) {
  if (!a || !b) return false;
  const ka = Object.keys(a).sort(); const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false;
    if (JSON.stringify(a[ka[i]]) !== JSON.stringify(b[kb[i]])) return false;
  }
  return true;
}

// ----- sessions -----
app.post('/api/sessions', requireRole('editor'), async (req, res) => {
  try {
    const s = await sessions.createSession({ projectId: req.project.id, ownerUserId: req.userId });
    res.status(201).json({ id: s.id, startedAt: s.startedAt });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sessions/:id', async (req, res) => {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ? AND project_id = ?').get(req.params.id, req.project.id);
  if (!row) return res.status(404).json({ error: 'session not found' });
  const live = await sessions.get(req.params.id).catch(() => null);
  res.json({ ...row, eventsCount: live ? live.events.length : row.events_count, live: !!live });
});

app.delete('/api/sessions/:id', async (req, res) => {
  const row = db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(req.params.id);
  if (!row || row.project_id !== req.project.id) return res.status(404).json({ error: 'session not found' });
  await sessions.closeSession(req.params.id);
  res.json({ ok: true });
});

// Helper used by all session sub-routes — ensures session belongs to current project.
async function getSessionInProject(req) {
  const row = db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(req.params.id);
  if (!row || row.project_id !== req.project.id) return null;
  return await sessions.get(req.params.id).catch(() => null);
}

// Generic action dispatcher
const ACTION_HANDLERS = {
  goto: actions.goto,
  click: actions.click,
  fill: actions.fill,
  select: actions.selectOption,
  press: actions.press,
  wait_for: actions.waitFor,
  wait_ms: actions.waitMs,
  screenshot: actions.screenshotAction,
  eval: actions.evalJs,
  toggle: actions.toggle,
  dialog: actions.handleDialog,
  extract: actions.extract,
  assert_eq: actions.assertEq,
};

for (const [name, handler] of Object.entries(ACTION_HANDLERS)) {
  app.post(`/api/sessions/:id/${name}`, requireRole('editor'), async (req, res) => {
    const s = await getSessionInProject(req);
    if (!s) return res.status(404).json({ error: 'session not found or closed' });
    try {
      const r = await handler(s, req.body || {});
      res.json(r);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
}

// snap is read-only (no event)
app.get('/api/sessions/:id/snap', async (req, res) => {
  const s = await getSessionInProject(req);
  if (!s) return res.status(404).json({ error: 'session not found' });
  try { res.json(await actions.snap(s)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sessions/:id/events', async (req, res) => {
  const s = await getSessionInProject(req);
  if (!s) return res.status(404).json({ error: 'session not found' });
  res.json({ events: s.events });
});

// Run a saved flow inline on the current session (orchestrator pattern for the agent).
// Persists the ctx (mailtmInstances, cleanup, etc) on the session so chained invokes
// share state — e.g. an OTP arriving in step N can be read by mailtm.wait in step N+1.
app.post('/api/sessions/:id/invoke-flow', requireRole('editor'), async (req, res) => {
  const s = await getSessionInProject(req);
  if (!s) return res.status(404).json({ error: 'session not found' });
  const { flowId, vars = {} } = req.body || {};
  if (!flowId) return res.status(400).json({ error: 'flowId required' });
  const f = db.prepare('SELECT project_id FROM flows WHERE id = ?').get(flowId);
  if (!f || f.project_id !== req.project.id) return res.status(404).json({ error: `flow not found in this project: ${flowId}` });
  try {
    s.flowCtx = s.flowCtx || { cleanup: [], mailtmInstances: {} };
    const r = await runFlowOnSession({ flowId, overrides: vars, session: s, ctx: s.flowCtx, projectId: req.project.id });
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Save session as a flow
app.post('/api/sessions/:id/save-flow', requireRole('editor'), async (req, res) => {
  const s = await getSessionInProject(req);
  if (!s) return res.status(404).json({ error: 'session not found' });
  const { name, description, vars = [], assertions = [] } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });

  const flowId = (req.body.id || name.toLowerCase().replace(/[^a-z0-9]+/g, '-')).slice(0, 60);
  const steps = s.events.map((e, i) => ({ n: i + 1, action: e.action, args: e.args }));
  const flow = { id: flowId, name, description, vars, steps, assertions };

  db.prepare(`INSERT OR REPLACE INTO flows (id, name, description, json, project_id, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`)
    .run(flowId, name, description || null, JSON.stringify(flow), req.project.id);

  res.status(201).json({ flow });
});

// ----- flows -----
app.get('/api/flows', (req, res) => {
  const rows = db.prepare('SELECT id, name, description, json, created_at, updated_at FROM flows WHERE project_id = ? ORDER BY updated_at DESC').all(req.project.id);
  // Surface top-level YAML metadata: kind (helper/subflow) and exported vars
  // so the UI can group reusable sub-flows separately from primary flows.
  const flows = rows.map(r => {
    let kind = null, vars = [];
    try {
      const j = JSON.parse(r.json);
      kind = j.kind || null;
      vars = Array.isArray(j.vars) ? j.vars.map(v => v.name).filter(Boolean) : [];
    } catch {}
    return { id: r.id, name: r.name, description: r.description, kind, vars, created_at: r.created_at, updated_at: r.updated_at };
  });
  res.json({ flows });
});

app.get('/api/flows/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM flows WHERE id = ? AND project_id = ?').get(req.params.id, req.project.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json({ ...row, json: JSON.parse(row.json) });
});

app.post('/api/flows', requireRole('editor'), (req, res) => {
  const { id, name, description, vars = [], steps = [], assertions = [] } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const flowId = (id || name.toLowerCase().replace(/[^a-z0-9]+/g, '-')).slice(0, 60);
  // If already exists in another project, refuse (avoid cross-project id collision)
  const existing = db.prepare('SELECT project_id FROM flows WHERE id = ?').get(flowId);
  if (existing && existing.project_id && existing.project_id !== req.project.id) {
    return res.status(409).json({ error: `flow id "${flowId}" already exists in another project` });
  }
  const flow = { id: flowId, name, description, vars, steps, assertions };
  db.prepare(`INSERT OR REPLACE INTO flows (id, name, description, json, project_id, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`)
    .run(flowId, name, description || null, JSON.stringify(flow), req.project.id);
  res.status(201).json({ flow });
});

app.delete('/api/flows/:id', requireRole('editor'), (req, res) => {
  db.prepare('DELETE FROM flows WHERE id = ? AND project_id = ?').run(req.params.id, req.project.id);
  res.json({ ok: true });
});

// ----- replay -----
// Fire-and-forget post-run LLM linter. Catches its own errors so a model hiccup
// can't crash the replay path or leak through to the user.
function maybeRunLLMLint(runId, projectId) {
  if (!llmLinter.isEnabled()) return;
  setImmediate(() => {
    llmLinter.lintRun({ runId, projectId })
      .then((r) => { if (r?.count) console.log(`[llm-linter] run ${runId}: ${r.count} verdicts`); })
      .catch((e) => console.warn(`[llm-linter] run ${runId} failed: ${e.message}`));
  });
}

app.post('/api/flows/:id/replay', requireRole('editor'), async (req, res) => {
  const flowRow = db.prepare('SELECT project_id FROM flows WHERE id = ?').get(req.params.id);
  if (!flowRow || flowRow.project_id !== req.project.id) return res.status(404).json({ error: 'flow not found in this project' });
  const stream = req.query.stream === 'true' || req.query.stream === '1';
  const overrides = req.body?.vars || {};
  const meta = { projectId: req.project.id, triggeredBy: req.userId };

  if (!stream) {
    try {
      const result = await executeReplay(req.params.id, overrides, null, meta);
      maybeRunLLMLint(result.runId, req.project.id);
      return res.json({ ...result, runUrl: `${PUBLIC_BASE_URL}/runs/${result.runId}` });
    } catch (e) { return res.status(400).json({ error: e.message }); }
  }

  // SSE mode: stream events live as the replay executes
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const send = (event) => {
    try {
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {}
  };

  // heartbeat every 15s so proxies don't close the connection during long waits (OTP polling)
  const heartbeat = setInterval(() => { try { res.write(`: ping\n\n`); } catch {} }, 15000);

  let clientGone = false;
  req.on('close', () => { clientGone = true; });

  try {
    const result = await executeReplay(req.params.id, overrides, (ev) => {
      if (!clientGone) send(ev);
    }, meta);
    maybeRunLLMLint(result.runId, req.project.id);
    if (!clientGone) send({ type: 'done', ...result, runUrl: `${PUBLIC_BASE_URL}/runs/${result.runId}` });
  } catch (e) {
    if (!clientGone) send({ type: 'error', error: e.message });
  } finally {
    clearInterval(heartbeat);
    try { res.end(); } catch {}
  }
});

// ----- runs -----
app.get('/api/runs', (req, res) => {
  const rows = db.prepare('SELECT id, flow_id, flow_name, status, started_at, finished_at, error, triggered_by FROM runs WHERE project_id = ? ORDER BY started_at DESC LIMIT 100').all(req.project.id);
  res.json({ runs: rows });
});

/**
 * Hydrate a result.steps[].findings[] payload with cross-run triage state and
 * notes counts. Mutates `result` in place. Used by both the authenticated
 * /api/runs/:id and the public /runs/:id viewer.
 */
function enrichFindings(result, projectId) {
  if (!result?.steps) return;
  const sigs = new Set();
  for (const s of result.steps) for (const f of (s.findings || [])) sigs.add(f.signature);
  if (sigs.size === 0) return;
  const placeholders = Array.from(sigs).map(() => '?').join(',');
  const triages = db.prepare(`SELECT * FROM finding_triage WHERE project_id = ? AND finding_signature IN (${placeholders})`).all(projectId, ...sigs);
  const tMap = new Map(triages.map(t => [t.finding_signature, t]));
  const noteCounts = db.prepare(`SELECT finding_signature, COUNT(*) as c FROM finding_notes WHERE project_id = ? AND finding_signature IN (${placeholders}) GROUP BY finding_signature`).all(projectId, ...sigs);
  const nMap = new Map(noteCounts.map(n => [n.finding_signature, n.c]));
  const llmVerdicts = db.prepare(`SELECT finding_signature, verdict, reason, model, ran_at FROM finding_llm_verdicts WHERE project_id = ? AND finding_signature IN (${placeholders})`).all(projectId, ...sigs);
  const lMap = new Map(llmVerdicts.map(v => [v.finding_signature, v]));
  for (const s of result.steps) for (const f of (s.findings || [])) {
    const t = tMap.get(f.signature);
    if (t) f.triage = { status: t.status, reason: t.reason, triaged_by: t.triaged_by, triaged_at: t.triaged_at, llm_verdict: t.llm_verdict, llm_reason: t.llm_reason, suppressed_by_rule_id: t.rule_id };
    const nc = nMap.get(f.signature);
    if (nc) f.notes_count = nc;
    const lv = lMap.get(f.signature);
    if (lv) f.llm = { verdict: lv.verdict, reason: lv.reason, model: lv.model, ran_at: lv.ran_at };
  }
}

app.get('/api/runs/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM runs WHERE id = ? AND project_id = ?').get(req.params.id, req.project.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const result = row.result_json ? JSON.parse(row.result_json) : null;
  const vars = row.vars_json ? JSON.parse(row.vars_json) : null;
  enrichFindings(result, req.project.id);
  res.json({ ...row, result, vars });
});

// Trigger the LLM linter pass for a run on demand. Editor+ only.
// Returns { ranAt, count } on success; { skipped: '...' } when there's
// nothing to lint (no findings, no context, or feature disabled).
app.post('/api/runs/:id/llm-lint', requireRole('editor'), async (req, res) => {
  const run = db.prepare('SELECT id, project_id FROM runs WHERE id = ? AND project_id = ?').get(req.params.id, req.project.id);
  if (!run) return res.status(404).json({ error: 'run not found' });
  try {
    const result = await llmLinter.lintRun({ runId: req.params.id, projectId: req.project.id });
    if (result.error) return res.status(502).json({ error: result.error });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----- finding triage -----
app.post('/api/runs/:id/findings/:sig/triage', requireRole('editor'), (req, res) => {
  const run = db.prepare('SELECT id, project_id FROM runs WHERE id = ? AND project_id = ?').get(req.params.id, req.project.id);
  if (!run) return res.status(404).json({ error: 'run not found' });
  const { status, reason } = req.body || {};
  if (!['bug', 'not_a_bug', 'investigating', 'accepted_risk'].includes(status)) {
    return res.status(400).json({ error: `invalid status: ${status}` });
  }
  if (status === 'not_a_bug' && !reason) return res.status(400).json({ error: 'reason required for not_a_bug' });
  db.prepare(`
    INSERT INTO finding_triage (finding_signature, project_id, status, reason, triaged_by, triaged_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT (finding_signature, project_id) DO UPDATE SET
      status = excluded.status,
      reason = excluded.reason,
      triaged_by = excluded.triaged_by,
      triaged_at = CURRENT_TIMESTAMP
  `).run(req.params.sig, req.project.id, status, reason || null, req.userId);
  res.json({ ok: true });
});

app.delete('/api/runs/:id/findings/:sig/triage', requireRole('editor'), (req, res) => {
  db.prepare('DELETE FROM finding_triage WHERE finding_signature = ? AND project_id = ?')
    .run(req.params.sig, req.project.id);
  res.json({ ok: true });
});

app.get('/api/runs/:id/findings/:sig/notes', (req, res) => {
  const notes = db.prepare(`SELECT n.id, n.body, n.author_id, n.created_at, n.updated_at, u.email as author_email, u.name as author_name
    FROM finding_notes n LEFT JOIN users u ON u.id = n.author_id
    WHERE n.finding_signature = ? AND n.project_id = ?
    ORDER BY n.created_at ASC`).all(req.params.sig, req.project.id);
  res.json({ notes });
});

app.post('/api/runs/:id/findings/:sig/notes', requireRole('editor'), (req, res) => {
  const run = db.prepare('SELECT id, project_id FROM runs WHERE id = ? AND project_id = ?').get(req.params.id, req.project.id);
  if (!run) return res.status(404).json({ error: 'run not found' });
  const body = String(req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'body required' });
  const id = require('crypto').randomBytes(8).toString('hex');
  db.prepare('INSERT INTO finding_notes (id, finding_signature, project_id, run_id, author_id, body) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, req.params.sig, req.project.id, req.params.id, req.userId, body);
  res.status(201).json({ ok: true, id });
});

app.delete('/api/runs/:id/findings/:sig/notes/:noteId', requireRole('editor'), (req, res) => {
  // Only author can delete
  const note = db.prepare('SELECT author_id FROM finding_notes WHERE id = ? AND project_id = ?').get(req.params.noteId, req.project.id);
  if (!note) return res.status(404).json({ error: 'note not found' });
  if (note.author_id !== req.userId) return res.status(403).json({ error: 'only the author can delete' });
  db.prepare('DELETE FROM finding_notes WHERE id = ?').run(req.params.noteId);
  res.json({ ok: true });
});

// ===== new run-detail sub-endpoints =====

app.get('/api/runs/:id/http-calls', (req, res) => {
  const run = db.prepare('SELECT id FROM runs WHERE id = ? AND project_id = ?').get(req.params.id, req.project.id);
  if (!run) return res.status(404).json({ error: 'run not found' });
  const calls = db.prepare(`
    SELECT id, run_id, step_n, trace_id, method, url,
           response_status, latency_ms,
           request_headers, request_body,
           response_headers, response_body, error,
           created_at
    FROM http_calls
    WHERE run_id = ?
    ORDER BY id ASC
  `).all(req.params.id);
  res.json({ calls });
});

app.get('/api/runs/:id/audit-entries', (req, res) => {
  const run = db.prepare('SELECT id FROM runs WHERE id = ? AND project_id = ?').get(req.params.id, req.project.id);
  if (!run) return res.status(404).json({ error: 'run not found' });
  const entries = db.prepare(`
    SELECT id, run_id, step_n, trace_id, audit_log_id,
           action, http_status, status, latency_ms,
           user_id, raw_json, fetched_at
    FROM audit_entries
    WHERE run_id = ?
    ORDER BY id ASC
  `).all(req.params.id);
  res.json({ entries });
});

// ===== export for testing =====
function makeApp() { return app; }
module.exports = { makeApp, app };

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[pageflows] :${PORT}`);
    console.log(`  PUBLIC_BASE_URL=${PUBLIC_BASE_URL}`);
    console.log(`  BROWSERLESS_WS=${process.env.BROWSERLESS_WS}`);
    console.log(`  DATA_DIR=${DATA_DIR}`);

    // Cron scheduler — opt-out via DISABLE_SCHEDULER for local debugging
    if (process.env.DISABLE_SCHEDULER !== '1') {
      scheduler.start({ db, executeReplay });
    }
  });
}
