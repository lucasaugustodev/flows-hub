/**
 * Sessions — wrapper around Playwright connected to Browserless.
 *
 * Each session = 1 BrowserContext + 1 Page + events buffer (the recorder).
 *
 * Sessions survive an API container restart by persisting the Browserless
 * wsEndpoint (issued by Browserless when we connect with `?reconnect=N`) to
 * SQLite. On startup or first access after restart, we attempt to reconnect
 * to the same browser. If the browser was already torn down by Browserless
 * (after its reconnect grace window), the session is marked `expired`.
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { chromium } = require('playwright-core');
const db = require('./db');

const BROWSERLESS_WS = process.env.BROWSERLESS_WS || 'ws://localhost:3000';
const DATA_DIR = process.env.DATA_DIR || './data';
// keep the browser alive for this long after our WS disconnects, so we can
// reconnect after an API restart. 30 min is plenty for any recording session.
const RECONNECT_MS = parseInt(process.env.BROWSERLESS_RECONNECT_MS || '1800000', 10);

const sessions = new Map(); // sessionId → { browser, context, page, ... }

function newSessionId() {
  return crypto.randomBytes(8).toString('hex');
}

function buildConnectUrl(base) {
  // Browserless OSS doesn't accept reconnect/keepalive query params.
  // We persist the wsEndpoint in the DB; on reconnect attempt we try chromium.connect(savedEndpoint),
  // which works while Browserless's CONNECTION_TIMEOUT keeps the browser alive.
  return base;
}

function sessionDir(id) {
  return path.join(DATA_DIR, 'sessions', id);
}

function ensureDir(id) {
  const dir = sessionDir(id);
  fs.mkdirSync(path.join(dir, 'screenshots'), { recursive: true });
  return dir;
}

function loadEventsFromDisk(id) {
  const p = path.join(sessionDir(id), 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function buildSession(id, browser, context, page) {
  const dir = ensureDir(id);
  const eventsPath = path.join(dir, 'events.jsonl');
  return {
    id,
    browser,
    context,
    page,
    eventsPath,
    events: loadEventsFromDisk(id),
    screenshotsDir: path.join(dir, 'screenshots'),
    startedAt: Date.now(),
  };
}

async function createSession({ projectId = null, ownerUserId = null } = {}) {
  const id = newSessionId();
  const browser = (BROWSERLESS_WS && process.env.USE_BROWSERLESS === '1')
    ? await chromium.connect(buildConnectUrl(BROWSERLESS_WS))
    : await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  const sess = buildSession(id, browser, context, page);
  sess.projectId = projectId;
  sess.ownerUserId = ownerUserId;
  sessions.set(id, sess);

  let wsEndpoint = null;
  try { wsEndpoint = browser.wsEndpoint(); } catch {}

  db.prepare('INSERT INTO sessions (id, status, ws_endpoint, last_seen, project_id, owner_user_id) VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, ?)')
    .run(id, 'active', wsEndpoint, projectId, ownerUserId);

  return sess;
}

async function tryReconnect(id) {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  if (!row || row.status !== 'active' || !row.ws_endpoint) return null;
  try {
    const browser = await chromium.connect(row.ws_endpoint);
    const contexts = browser.contexts();
    if (!contexts.length) { try { await browser.close(); } catch {} ; throw new Error('no contexts'); }
    const context = contexts[0];
    const pages = context.pages();
    if (!pages.length) { try { await browser.close(); } catch {} ; throw new Error('no pages'); }
    const page = pages[0];
    page.setDefaultTimeout(30000);
    const sess = buildSession(id, browser, context, page);
    sessions.set(id, sess);
    db.prepare('UPDATE sessions SET last_seen = CURRENT_TIMESTAMP WHERE id = ?').run(id);
    return sess;
  } catch (e) {
    db.prepare('UPDATE sessions SET status = ?, closed_at = CURRENT_TIMESTAMP WHERE id = ?').run('expired', id);
    return null;
  }
}

async function get(id) {
  const live = sessions.get(id);
  if (live) {
    db.prepare('UPDATE sessions SET last_seen = CURRENT_TIMESTAMP WHERE id = ?').run(id);
    return live;
  }
  // Not in memory — try to reconnect (covers API restart).
  return await tryReconnect(id);
}

async function closeSession(id) {
  const s = sessions.get(id) || (await tryReconnect(id));
  if (s) {
    try { await s.context.close(); } catch {}
    try { await s.browser.close(); } catch {}
    sessions.delete(id);
  }
  db.prepare('UPDATE sessions SET status = ?, closed_at = CURRENT_TIMESTAMP, events_count = ? WHERE id = ?')
    .run('closed', s ? s.events.length : 0, id);
}

function appendEvent(s, ev) {
  ev.t = Date.now();
  ev.n = s.events.length + 1;
  s.events.push(ev);
  try { fs.appendFileSync(s.eventsPath, JSON.stringify(ev) + '\n'); } catch {}
  try { db.prepare('UPDATE sessions SET events_count = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?').run(s.events.length, s.id); } catch {}
}

async function snapshot(s, label) {
  const file = path.join(s.screenshotsDir, `${String(s.events.length).padStart(3, '0')}-${(label || 'snap').replace(/\W+/g, '-').slice(0, 30)}.png`);
  try { await s.page.screenshot({ path: file }); } catch (e) { return null; }
  return path.relative(DATA_DIR, file);
}

module.exports = { createSession, get, closeSession, appendEvent, snapshot };
