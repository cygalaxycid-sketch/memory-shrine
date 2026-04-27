// Virtual wallet operations. All amounts are plain numbers (no real money).
const db = require('./db');

function getBalance(userId) {
  const row = db.prepare('SELECT wallet_balance FROM users WHERE id = ?').get(userId);
  return row ? row.wallet_balance : 0;
}

function recordTx(userId, amount, type, opts = {}) {
  db.prepare(
    `INSERT INTO wallet_transactions (user_id, amount, type, task_id, sub_task_id, note)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(userId, amount, type, opts.task_id || null, opts.sub_task_id || null, opts.note || null);
}

// Adjust balance by delta (positive = credit, negative = debit). Throws if insufficient funds.
function adjustBalance(userId, delta) {
  const user = db.prepare('SELECT wallet_balance FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error('User not found');
  const next = +(user.wallet_balance + delta).toFixed(2);
  if (next < 0) throw new Error('Insufficient wallet balance');
  db.prepare('UPDATE users SET wallet_balance = ? WHERE id = ?').run(next, userId);
  return next;
}

// Top up own wallet (virtual deposit, since v1 has no real payments).
function deposit(req, res) {
  const amount = Number(req.body && req.body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Amount must be a positive number' });
  }
  if (amount > 1000000) {
    return res.status(400).json({ error: 'Amount too large' });
  }
  const tx = db.transaction(() => {
    const newBalance = adjustBalance(req.user.id, amount);
    recordTx(req.user.id, amount, 'deposit', { note: 'Virtual deposit' });
    return newBalance;
  });
  res.json({ balance: tx() });
}

function balance(req, res) {
  res.json({ balance: getBalance(req.user.id) });
}

function transactions(req, res) {
  const rows = db.prepare(
    'SELECT id, amount, type, task_id, sub_task_id, note, created_at FROM wallet_transactions WHERE user_id = ? ORDER BY id DESC LIMIT 200'
  ).all(req.user.id);
  res.json({ transactions: rows });
}

module.exports = { getBalance, adjustBalance, recordTx, deposit, balance, transactions };
