/**
 * SQLite — flows, runs, sessions metadata.
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_FILE = process.env.DB_FILE || './data/pageflows.db';
const DIR = path.dirname(DB_FILE);
if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS flows (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    flow_id TEXT,
    flow_name TEXT,
    status TEXT NOT NULL,                 -- queued | running | passed | failed
    vars_json TEXT,
    result_json TEXT,
    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at TEXT,
    error TEXT
  );

  CREATE INDEX IF NOT EXISTS runs_flow ON runs(flow_id);
  CREATE INDEX IF NOT EXISTS runs_started ON runs(started_at DESC);

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,                 -- active | closed | expired
    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    closed_at TEXT,
    events_count INTEGER NOT NULL DEFAULT 0,
    ws_endpoint TEXT,
    last_seen TEXT
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,            -- scrypt: salt:hash:N:r:p
    name TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  -- Findings: anomalies the linter raises during a run. Stored inline in runs.result_json
  -- per step, but cross-run triage state lives in finding_triage so triaging in run A
  -- carries over to run B if the signature matches.
  CREATE TABLE IF NOT EXISTS finding_triage (
    finding_signature TEXT NOT NULL,
    project_id TEXT NOT NULL,
    status TEXT NOT NULL,                   -- bug | not_a_bug | investigating | accepted_risk
    reason TEXT,
    rule_id TEXT,                           -- FK to suppression_rules (PR-3.3)
    llm_verdict TEXT,                       -- kept | downgraded | suppressed (PR-3.2)
    llm_reason TEXT,
    triaged_by TEXT,
    triaged_at TEXT,
    PRIMARY KEY (finding_signature, project_id)
  );

  CREATE TABLE IF NOT EXISTS finding_notes (
    id TEXT PRIMARY KEY,
    finding_signature TEXT NOT NULL,
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    author_id TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_finding_notes_sig ON finding_notes(finding_signature, project_id);
  CREATE INDEX IF NOT EXISTS idx_finding_notes_run ON finding_notes(run_id);

  -- Advisory verdicts from the LLM linter pass. Lives separately from
  -- finding_triage so a model run can never overwrite a human's manual
  -- triage. Surfaces in the UI as a "🤖 suggested:" badge alongside any
  -- existing manual triage.
  CREATE TABLE IF NOT EXISTS finding_llm_verdicts (
    finding_signature TEXT NOT NULL,
    project_id TEXT NOT NULL,
    verdict TEXT NOT NULL,                  -- kept | downgraded | suppressed
    reason TEXT,
    model TEXT,
    ran_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (finding_signature, project_id)
  );

  -- Project-scoped rules that auto-suppress findings matching a JSON DSL.
  -- Evaluated by src/rules.js after each replay; matched findings get an
  -- auto-triage row in finding_triage with triaged_by='rule' + rule_id.
  CREATE TABLE IF NOT EXISTS suppression_rules (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    expr_json TEXT NOT NULL,                -- DSL: { type, severity, evidence.x, ... }
    enabled INTEGER NOT NULL DEFAULT 1,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_suppression_rules_project ON suppression_rules(project_id, enabled);

  -- Scheduled flow runs. Polled once per minute by the scheduler. Uses standard
  -- 5-field cron expressions evaluated in UTC; @hourly/@daily/@weekly shorthands
  -- accepted. vars_json is the override map merged into the flow's defaults.
  CREATE TABLE IF NOT EXISTS scheduled_runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    flow_id TEXT NOT NULL,
    name TEXT,
    cron_expr TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    vars_json TEXT,
    last_fired_at TEXT,
    last_run_id TEXT,
    last_status TEXT,
    last_error TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_scheduled_runs_project ON scheduled_runs(project_id, enabled);

  -- Two-stage signup: data + OTP hash live here until the user verifies.
  CREATE TABLE IF NOT EXISTS pending_signups (
    email TEXT PRIMARY KEY COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    name TEXT,
    otp_hash TEXT NOT NULL,                 -- sha256 of the 6-digit code
    otp_attempts INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL,                     -- session | api
    name TEXT,                              -- e.g. "ci", "my-laptop"
    key_hash TEXT NOT NULL UNIQUE,          -- sha256(token)
    key_prefix TEXT NOT NULL,               -- first 12 chars for display only
    expires_at TEXT,
    last_used_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS tokens_user ON tokens(user_id);

  -- Usage tracking. We don't bill yet, but we record per-action usage so we can
  -- later compute per-user / per-project consumption (replays, agent LLM tokens, etc).
  CREATE TABLE IF NOT EXISTS usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    project_id TEXT,
    action TEXT NOT NULL,                   -- session.action | replay | agent.tool_call | agent.llm
    details_json TEXT,                      -- {model,tokens_in,tokens_out,cost_micros,duration_ms,...}
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS usage_user ON usage_log(user_id, created_at);
  CREATE INDEX IF NOT EXISTS usage_project ON usage_log(project_id, created_at);

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    description TEXT,
    -- Free-form markdown describing the project: tech stack, what's
    -- expected/tolerable, known quirks, links to dashboards. Used by the
    -- LLM linter pass (PR-3.2) to tell real bugs from accepted oddities.
    context_md TEXT,
    owner_id TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS project_members (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    role TEXT NOT NULL,                     -- owner | admin | editor | viewer
    invited_by TEXT,
    joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS pm_user ON project_members(user_id);

  CREATE TABLE IF NOT EXISTS invites (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    code TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL,                     -- admin | editor | viewer
    created_by TEXT NOT NULL,
    expires_at TEXT,
    used_at TEXT,
    used_by TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS invites_project ON invites(project_id);

  -- Project-scoped variable store. Used as default values for flow vars during
  -- replay, so users (and the agent) can save credentials and other constants
  -- once and reuse them across all flows in the project.
  CREATE TABLE IF NOT EXISTS project_vars (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    value TEXT NOT NULL,
    is_secret INTEGER NOT NULL DEFAULT 0,
    description TEXT,
    updated_by TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, name)
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS http_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    step_n INTEGER NOT NULL,
    trace_id TEXT NOT NULL,
    method TEXT NOT NULL,
    url TEXT NOT NULL,
    request_headers TEXT,
    request_body TEXT,
    response_status INTEGER,
    response_headers TEXT,
    response_body TEXT,
    latency_ms INTEGER,
    error TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_http_calls_run ON http_calls (run_id);
  CREATE INDEX IF NOT EXISTS idx_http_calls_trace ON http_calls (trace_id);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS audit_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    step_n INTEGER NOT NULL,
    trace_id TEXT NOT NULL,
    audit_log_id INTEGER,
    action TEXT,
    http_status INTEGER,
    status TEXT,
    latency_ms INTEGER,
    user_id TEXT,
    raw_json TEXT,
    fetched_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_audit_entries_run ON audit_entries (run_id);
  CREATE INDEX IF NOT EXISTS idx_audit_entries_trace ON audit_entries (trace_id);
`);

// Add project_id to existing tables (idempotent: ignore "duplicate column" errors)
for (const sql of [
  `ALTER TABLE flows ADD COLUMN project_id TEXT`,
  `ALTER TABLE runs ADD COLUMN project_id TEXT`,
  `ALTER TABLE sessions ADD COLUMN project_id TEXT`,
  `ALTER TABLE sessions ADD COLUMN owner_user_id TEXT`,
  `ALTER TABLE runs ADD COLUMN triggered_by TEXT`,
]) {
  try { db.exec(sql); } catch { /* already exists */ }
}
for (const sql of [
  `CREATE INDEX IF NOT EXISTS flows_project ON flows(project_id)`,
  `CREATE INDEX IF NOT EXISTS runs_project ON runs(project_id, started_at DESC)`,
  `CREATE INDEX IF NOT EXISTS sessions_project ON sessions(project_id)`,
]) { try { db.exec(sql); } catch {} }

// add columns to old DBs (idempotent: ignore "duplicate column" errors)
for (const sql of [
  `ALTER TABLE sessions ADD COLUMN ws_endpoint TEXT`,
  `ALTER TABLE sessions ADD COLUMN last_seen TEXT`,
  `ALTER TABLE projects ADD COLUMN context_md TEXT`,
]) {
  try { db.exec(sql); } catch { /* already exists */ }
}

function recordHttpCall(callRecord) {
  return db.prepare(`INSERT INTO http_calls
    (run_id, step_n, trace_id, method, url, request_headers, request_body,
     response_status, response_headers, response_body, latency_ms, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    callRecord.run_id, callRecord.step_n, callRecord.trace_id, callRecord.method,
    callRecord.url, callRecord.request_headers, callRecord.request_body,
    callRecord.response_status, callRecord.response_headers, callRecord.response_body,
    callRecord.latency_ms, callRecord.error,
  );
}

function recordAuditEntry(entry) {
  return db.prepare(`INSERT INTO audit_entries
    (run_id, step_n, trace_id, audit_log_id, action, http_status, status,
     latency_ms, user_id, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.run_id, entry.step_n, entry.trace_id, entry.audit_log_id,
    entry.action, entry.http_status, entry.status,
    entry.latency_ms, entry.user_id, entry.raw_json,
  );
}

db.recordHttpCall = recordHttpCall;
db.recordAuditEntry = recordAuditEntry;
module.exports = db;
