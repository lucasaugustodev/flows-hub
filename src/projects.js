/**
 * Projects + members + invites + initial migration.
 *
 * Roles (more → less power): owner > admin > editor > viewer.
 *  - viewer:  list flows/runs, read details, no mutations
 *  - editor:  + create/edit flows, record sessions, run replays/agents
 *  - admin:   + invite/remove members, edit project settings
 *  - owner:   + delete project, transfer ownership
 *
 * One person creates a project (becomes owner); they invite others by code.
 */
const crypto = require('crypto');
const db = require('./db');

const ROLES = ['viewer', 'editor', 'admin', 'owner'];
const ROLE_RANK = { viewer: 1, editor: 2, admin: 3, owner: 4 };

function newId() { return crypto.randomBytes(8).toString('hex'); }
function newCode() {
  // human-friendly invite code: 3 groups of 4 chars (uppercase + digits, no ambiguous)
  const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pick = () => alpha[crypto.randomInt(0, alpha.length)];
  return Array.from({ length: 3 }, () => Array.from({ length: 4 }, pick).join('')).join('-');
}

function slugify(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'project';
}

function ensureUniqueSlug(base) {
  let slug = base, i = 1;
  while (db.prepare('SELECT 1 FROM projects WHERE slug = ?').get(slug)) {
    i++; slug = `${base}-${i}`;
  }
  return slug;
}

function createProject({ name, slug, description = null, ownerId }) {
  if (!name || !ownerId) throw new Error('name and ownerId required');
  const finalSlug = ensureUniqueSlug(slug ? slugify(slug) : slugify(name));
  const id = newId();
  db.prepare('INSERT INTO projects (id, slug, name, description, owner_id) VALUES (?, ?, ?, ?, ?)').run(id, finalSlug, name, description, ownerId);
  db.prepare('INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)').run(id, ownerId, 'owner');
  // Internal-mode: auto-share with all other real users as editors.
  if (process.env.AUTO_SHARE_PROJECTS !== 'false') {
    const others = db.prepare("SELECT id FROM users WHERE id != ? AND id != 'system'").all(ownerId);
    const stmt = db.prepare('INSERT OR IGNORE INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)');
    for (const u of others) stmt.run(id, u.id, 'editor');
  }
  return getProject(id);
}

/**
 * Internal-mode helper: when a new user signs up, auto-add them as editor in every
 * existing project so the team shares everything by default.
 */
function autoShareUserWithAllProjects(userId) {
  if (process.env.AUTO_SHARE_PROJECTS === 'false') return;
  const projects = db.prepare('SELECT id FROM projects').all();
  const stmt = db.prepare('INSERT OR IGNORE INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)');
  for (const p of projects) stmt.run(p.id, userId, 'editor');
}

function getProject(id) {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) || null;
}

function getProjectBySlug(slug) {
  return db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug) || null;
}

function listProjectsForUser(userId) {
  return db.prepare(`
    SELECT p.id, p.slug, p.name, p.description, p.owner_id, p.created_at, m.role
    FROM projects p
    JOIN project_members m ON m.project_id = p.id
    WHERE m.user_id = ?
    ORDER BY p.created_at DESC
  `).all(userId);
}

function getMembership(projectId, userId) {
  return db.prepare('SELECT * FROM project_members WHERE project_id = ? AND user_id = ?').get(projectId, userId) || null;
}

function listMembers(projectId) {
  return db.prepare(`
    SELECT m.user_id, m.role, m.joined_at, u.email, u.name
    FROM project_members m
    JOIN users u ON u.id = m.user_id
    WHERE m.project_id = ?
    ORDER BY m.joined_at ASC
  `).all(projectId);
}

function setRole({ projectId, userId, role }) {
  if (!ROLES.includes(role)) throw new Error(`invalid role: ${role}`);
  db.prepare('UPDATE project_members SET role = ? WHERE project_id = ? AND user_id = ?').run(role, projectId, userId);
}

function removeMember({ projectId, userId }) {
  db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(projectId, userId);
}

function addMember({ projectId, userId, role, invitedBy = null }) {
  if (!ROLES.includes(role)) throw new Error(`invalid role: ${role}`);
  db.prepare('INSERT OR IGNORE INTO project_members (project_id, user_id, role, invited_by) VALUES (?, ?, ?, ?)').run(projectId, userId, role, invitedBy);
}

function createInvite({ projectId, role, createdBy, expiresInDays = 14 }) {
  if (role === 'owner') throw new Error('cannot invite as owner');
  if (!ROLES.includes(role)) throw new Error(`invalid role: ${role}`);
  const id = newId();
  const code = newCode();
  const expiresAt = new Date(Date.now() + expiresInDays * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  db.prepare('INSERT INTO invites (id, project_id, code, role, created_by, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, projectId, code, role, createdBy, expiresAt);
  return { id, code, role, expiresAt };
}

function listInvites(projectId) {
  return db.prepare('SELECT id, code, role, created_by, expires_at, used_at, used_by, created_at FROM invites WHERE project_id = ? ORDER BY created_at DESC').all(projectId);
}

function revokeInvite({ projectId, id }) {
  db.prepare('DELETE FROM invites WHERE id = ? AND project_id = ?').run(id, projectId);
}

/**
 * Redeem an invite code. Returns the project the user joined.
 */
function redeemInvite({ code, userId }) {
  const inv = db.prepare('SELECT * FROM invites WHERE code = ?').get(code);
  if (!inv) throw new Error('invalid code');
  if (inv.used_at) throw new Error('code already used');
  if (inv.expires_at && new Date(inv.expires_at) < new Date()) throw new Error('code expired');
  // already a member?
  const exists = getMembership(inv.project_id, userId);
  if (exists) throw new Error(`already a member with role "${exists.role}"`);
  addMember({ projectId: inv.project_id, userId, role: inv.role, invitedBy: inv.created_by });
  db.prepare('UPDATE invites SET used_at = CURRENT_TIMESTAMP, used_by = ? WHERE id = ?').run(userId, inv.id);
  return getProject(inv.project_id);
}

/**
 * Middleware: X-Project header → req.project + req.role. Optional minimum role.
 */
function requireProject(minRole = 'viewer') {
  const minRank = ROLE_RANK[minRole];
  if (!minRank) throw new Error(`invalid minRole: ${minRole}`);
  return (req, res, next) => {
    const slug = req.header('X-Project') || req.query.project;
    if (!slug) return res.status(400).json({ error: 'X-Project header (or ?project=slug) required' });
    if (!req.userId) return res.status(401).json({ error: 'auth required' });
    const project = db.prepare(`
      SELECT p.*, m.role
      FROM projects p
      JOIN project_members m ON m.project_id = p.id
      WHERE p.slug = ? AND m.user_id = ?
    `).get(slug, req.userId);
    if (!project) return res.status(403).json({ error: `not a member of project "${slug}"` });
    if (ROLE_RANK[project.role] < minRank) return res.status(403).json({ error: `requires role ${minRole}+, you are ${project.role}` });
    req.project = project;
    req.role = project.role;
    next();
  };
}

/**
 * One-time migration: ensure legacy data is owned by something.
 *  1. Ensure a 'system' user exists (for legacy API_KEYS clients).
 *  2. If there are flows/runs/sessions with project_id IS NULL, create a default
 *     project ("Hub Portal" if there's a real human owner; else "system-default")
 *     and assign them.
 *  3. Add the system user as admin of that project so legacy clients keep working.
 */
function runMigration() {
  // 1. Ensure system user
  const systemId = 'system';
  const existsSystem = db.prepare('SELECT 1 FROM users WHERE id = ?').get(systemId);
  if (!existsSystem) {
    db.prepare('INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, ?, ?)')
      .run(systemId, 'system@pageflows.local', 'LEGACY:no-login', 'system');
  }

  // 2. Anything orphaned?
  const orphans = db.prepare('SELECT COUNT(*) c FROM flows WHERE project_id IS NULL').get().c;
  if (!orphans) return;

  // Pick the first real human user to be the owner. If none, system.
  const firstHuman = db.prepare("SELECT id FROM users WHERE id != 'system' ORDER BY created_at ASC LIMIT 1").get();
  const ownerId = firstHuman ? firstHuman.id : systemId;
  const projectName = firstHuman ? 'Hub Portal' : 'system-default';
  const projectSlug = firstHuman ? 'hub-portal' : 'system-default';

  // 3. Create the project (or reuse if it already exists)
  let proj = getProjectBySlug(projectSlug);
  if (!proj) proj = createProject({ name: projectName, slug: projectSlug, ownerId, description: 'Auto-migrated from pre-multitenant data.' });

  // Ensure system is admin of that project so legacy API_KEYS clients keep working.
  if (firstHuman) addMember({ projectId: proj.id, userId: systemId, role: 'admin' });

  // 4. Move orphans
  db.prepare('UPDATE flows SET project_id = ? WHERE project_id IS NULL').run(proj.id);
  db.prepare('UPDATE runs SET project_id = ? WHERE project_id IS NULL').run(proj.id);
  db.prepare('UPDATE sessions SET project_id = ? WHERE project_id IS NULL').run(proj.id);

  console.log(`[migration] moved ${orphans} flows + their runs/sessions to project "${proj.slug}" (owner: ${ownerId})`);
}

// ----- project vars (credentials/constants store) -----
function listVars(projectId, { revealSecrets = false } = {}) {
  const rows = db.prepare('SELECT name, value, is_secret, description, updated_by, updated_at FROM project_vars WHERE project_id = ? ORDER BY name').all(projectId);
  return rows.map(r => ({
    name: r.name,
    value: r.is_secret && !revealSecrets ? '<secret>' : r.value,
    is_secret: !!r.is_secret,
    description: r.description,
    updated_by: r.updated_by,
    updated_at: r.updated_at,
  }));
}

function getVarValue(projectId, name) {
  const r = db.prepare('SELECT value FROM project_vars WHERE project_id = ? AND name = ?').get(projectId, name);
  return r ? r.value : null;
}

function setVar({ projectId, name, value, isSecret = false, description = null, updatedBy = null }) {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) throw new Error(`var name must match /^[A-Za-z][A-Za-z0-9_]*$/: ${name}`);
  db.prepare(`
    INSERT INTO project_vars (project_id, name, value, is_secret, description, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT (project_id, name) DO UPDATE SET
      value = excluded.value,
      is_secret = excluded.is_secret,
      description = excluded.description,
      updated_by = excluded.updated_by,
      updated_at = CURRENT_TIMESTAMP
  `).run(projectId, name, value, isSecret ? 1 : 0, description, updatedBy);
}

function unsetVar({ projectId, name }) {
  db.prepare('DELETE FROM project_vars WHERE project_id = ? AND name = ?').run(projectId, name);
}

/**
 * Returns project vars as a plain {name: value} object — used by replay to seed flow vars.
 */
function getVarsAsObject(projectId) {
  const rows = db.prepare('SELECT name, value FROM project_vars WHERE project_id = ?').all(projectId);
  const out = {};
  for (const r of rows) out[r.name] = r.value;
  return out;
}

module.exports = {
  ROLES, ROLE_RANK,
  createProject, getProject, getProjectBySlug, listProjectsForUser,
  getMembership, listMembers, addMember, removeMember, setRole,
  createInvite, listInvites, revokeInvite, redeemInvite,
  requireProject, runMigration,
  listVars, getVarValue, setVar, unsetVar, getVarsAsObject,
  autoShareUserWithAllProjects,
};
