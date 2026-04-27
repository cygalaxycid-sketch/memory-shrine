// Authentication helpers: register, login, JWT middleware.
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const JWT_EXPIRES_IN = '7d';
const MAX_EMAIL_LEN = 254;
// Simple structural check: exactly one '@', non-empty local part with no
// whitespace, domain has a dot and a TLD-like suffix. Written without nested
// repetition on the same character class to avoid catastrophic-backtracking
// (polynomial ReDoS) on adversarial inputs.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
function isValidEmail(s) {
  return typeof s === 'string' && s.length <= MAX_EMAIL_LEN && EMAIL_RE.test(s);
}

function safeJson(s) {
  try { return JSON.parse(s || '{}'); } catch { return {}; }
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    wallet_balance: u.wallet_balance,
    preferences: safeJson(u.preferences),
  };
}

function signToken(user) {
  return jwt.sign({ uid: user.id, email: user.email }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

async function register(req, res) {
  const { email, password, name } = req.body || {};
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Valid email required' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 chars' });

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.status(409).json({ error: 'Email already registered' });

  const hash = await bcrypt.hash(password, 10);
  const info = db.prepare(
    'INSERT INTO users (email, password_hash, name, preferences) VALUES (?, ?, ?, ?)'
  ).run(email, hash, name || '', JSON.stringify({}));

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  res.json({ token: signToken(user), user: publicUser(user) });
}

async function login(req, res) {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
  res.json({ token: signToken(user), user: publicUser(user) });
}

function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer (.+)$/);
  if (!m) return res.status(401).json({ error: 'Missing token' });
  try {
    const payload = jwt.verify(m[1], JWT_SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.uid);
    if (!user) return res.status(401).json({ error: 'Invalid token' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function me(req, res) {
  res.json({ user: publicUser(req.user) });
}

module.exports = { register, login, requireAuth, me, publicUser, safeJson };
