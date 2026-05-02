/**
 * Authentication: users, password hashing (scrypt), opaque tokens, middleware.
 *
 * Token format: pf_<32 hex bytes>. The first 12 chars (incl. "pf_") are stored
 * as `key_prefix` for display; the full token is sha256-hashed for lookup so
 * the DB never contains the plaintext.
 *
 * Tokens have two kinds:
 *  - session: short-lived (30 days), created on login, revoked on logout
 *  - api:     long-lived, named, user-managed, used by CLI/agents
 *
 * Backwards compat: the old `API_KEYS` env var still works during migration.
 */
const crypto = require('crypto');
const db = require('./db');

// ----- legacy fallback (kept while we migrate clients to per-user tokens) -----
const LEGACY_KEYS = (process.env.API_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);

// Internal-only deployment: restrict signup to a domain (e.g., somosahub.com.br).
// Set SIGNUP_ALLOWED_DOMAIN='' to allow any.
const ALLOWED_DOMAIN = process.env.SIGNUP_ALLOWED_DOMAIN ?? 'somosahub.com.br';

function isAllowedEmail(email) {
  if (!ALLOWED_DOMAIN) return true;
  return String(email).toLowerCase().trim().endsWith('@' + ALLOWED_DOMAIN.toLowerCase());
}

// ----- password hashing -----
const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1, KEY_LEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `${salt.toString('hex')}:${hash.toString('hex')}:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}`;
}

function verifyPassword(password, stored) {
  try {
    const [saltHex, hashHex, N, r, p] = stored.split(':');
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const got = crypto.scryptSync(password, salt, expected.length, { N: parseInt(N, 10), r: parseInt(r, 10), p: parseInt(p, 10) });
    return crypto.timingSafeEqual(got, expected);
  } catch { return false; }
}

// ----- tokens -----
function newId() { return crypto.randomBytes(8).toString('hex'); }
function newToken() { return 'pf_' + crypto.randomBytes(32).toString('hex'); }
function hashToken(plain) { return crypto.createHash('sha256').update(plain).digest('hex'); }

function createUser({ email, password, name }) {
  email = email.trim().toLowerCase();
  if (!email || !password) throw new Error('email and password required');
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (exists) throw new Error('email already in use');
  const id = newId();
  db.prepare('INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, ?, ?)').run(id, email, hashPassword(password), name || null);
  return getUser(id);
}

function getUser(id) {
  const u = db.prepare('SELECT id, email, name, created_at FROM users WHERE id = ?').get(id);
  return u || null;
}

function findUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase()) || null;
}

function authenticate(email, password) {
  const u = findUserByEmail(email);
  if (!u) return null;
  if (!verifyPassword(password, u.password_hash)) return null;
  return { id: u.id, email: u.email, name: u.name, created_at: u.created_at };
}

/**
 * Issue a token. Returns { token (plaintext, only chance to see it), id, prefix }.
 */
function issueToken({ userId, kind, name = null, expiresInDays = null }) {
  const id = newId();
  const plain = newToken();
  const keyHash = hashToken(plain);
  const keyPrefix = plain.slice(0, 12);
  const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 86400000).toISOString().slice(0, 19).replace('T', ' ') : null;
  db.prepare('INSERT INTO tokens (id, user_id, kind, name, key_hash, key_prefix, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, userId, kind, name, keyHash, keyPrefix, expiresAt);
  return { id, token: plain, prefix: keyPrefix, kind, name, expiresAt };
}

function listTokens(userId, kind = null) {
  const where = kind ? 'WHERE user_id = ? AND kind = ? AND revoked_at IS NULL' : 'WHERE user_id = ? AND revoked_at IS NULL';
  const args = kind ? [userId, kind] : [userId];
  return db.prepare(`SELECT id, kind, name, key_prefix, expires_at, last_used_at, created_at FROM tokens ${where} ORDER BY created_at DESC`).all(...args);
}

function revokeToken({ userId, id }) {
  db.prepare('UPDATE tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?').run(id, userId);
}

function revokeTokenByValue(plain) {
  const keyHash = hashToken(plain);
  db.prepare('UPDATE tokens SET revoked_at = CURRENT_TIMESTAMP WHERE key_hash = ?').run(keyHash);
}

/**
 * Resolve an inbound key to a user (or null if invalid).
 * Side effect: stamps last_used_at on the token.
 * Falls back to LEGACY_KEYS env var, returning a synthetic system user_id.
 */
const SYSTEM_USER_ID = 'system';

function resolveKey(plain) {
  if (!plain) return null;
  const keyHash = hashToken(plain);
  const t = db.prepare('SELECT t.id, t.user_id, t.kind, t.expires_at, t.revoked_at, u.email, u.name FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.key_hash = ?').get(keyHash);
  if (t) {
    if (t.revoked_at) return null;
    if (t.expires_at && new Date(t.expires_at) < new Date()) return null;
    db.prepare('UPDATE tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(t.id);
    return { userId: t.user_id, email: t.email, name: t.name, tokenId: t.id, kind: t.kind, source: 'token' };
  }
  if (LEGACY_KEYS.includes(plain)) {
    return { userId: SYSTEM_USER_ID, email: 'system@pageflows', name: 'system (legacy API_KEYS)', tokenId: null, kind: 'api', source: 'legacy' };
  }
  return null;
}

// ----- middleware -----
function authMiddleware(req, res, next) {
  const key = req.header('X-API-Key') || (req.header('Authorization') || '').replace(/^Bearer\s+/i, '');
  const u = resolveKey(key);
  if (!u) return res.status(401).json({ error: 'invalid or missing credentials' });
  req.user = u;
  req.userId = u.userId;
  next();
}

// ----- usage logging -----
function logUsage({ userId, projectId = null, action, details = null }) {
  try {
    db.prepare('INSERT INTO usage_log (user_id, project_id, action, details_json) VALUES (?, ?, ?, ?)')
      .run(userId || null, projectId || null, action, details ? JSON.stringify(details) : null);
  } catch {}
}

module.exports = {
  authMiddleware,
  hashPassword, verifyPassword,
  createUser, authenticate, getUser, findUserByEmail,
  issueToken, listTokens, revokeToken, revokeTokenByValue,
  resolveKey, logUsage,
  SYSTEM_USER_ID,
  hashToken, newId,
  ALLOWED_DOMAIN, isAllowedEmail,
};
