// HTTP server: wires routes and serves static frontend.
const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');

const auth = require('./auth');
const wallet = require('./wallet');
const tasks = require('./tasks');

const app = express();
app.use(express.json({ limit: '256kb' }));

// Rate limiting protects auth endpoints from credential stuffing/brute-force
// and protects the rest of the API from runaway clients. Tests can disable
// the limiter by setting DISABLE_RATE_LIMIT=1.
const limiterEnabled = process.env.DISABLE_RATE_LIMIT !== '1';
const authLimiter = limiterEnabled
  ? rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false })
  : (req, res, next) => next();
const apiLimiter = limiterEnabled
  ? rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false })
  : (req, res, next) => next();

app.use('/api/', apiLimiter);

// ----- Public auth endpoints (extra-strict limiter on top of the global one) -----
app.post('/api/auth/register', authLimiter, auth.register);
app.post('/api/auth/login', authLimiter, auth.login);

// ----- Authenticated endpoints -----
app.get('/api/me', auth.requireAuth, auth.me);

app.get('/api/wallet', auth.requireAuth, wallet.balance);
app.post('/api/wallet/deposit', auth.requireAuth, wallet.deposit);
app.get('/api/wallet/transactions', auth.requireAuth, wallet.transactions);

app.get('/api/preferences', auth.requireAuth, tasks.getPreferences);
app.put('/api/preferences', auth.requireAuth, tasks.updatePreferences);

app.post('/api/tasks', auth.requireAuth, tasks.createTask);
app.get('/api/tasks', auth.requireAuth, tasks.listTasks);
app.get('/api/tasks/:id', auth.requireAuth, tasks.getTask);
app.post('/api/tasks/:id/claim', auth.requireAuth, tasks.claimTask);
app.post('/api/sub_tasks/:id/submit', auth.requireAuth, tasks.submitSubTask);

// ----- Static frontend -----
app.use(express.static(path.join(__dirname, '..', 'public')));

// ----- Error handler (last) -----
app.use((err, req, res, next) => {
  // eslint-disable-next-line no-console
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error' });
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Task marketplace listening on http://localhost:${PORT}`);
  });
}

module.exports = app;
