// Task creation, listing, claiming, submission, validation, and payout.
const db = require('./db');
const wallet = require('./wallet');
const { validate } = require('./aiValidator');
const { safeJson } = require('./auth');

function round2(n) { return Math.round(n * 100) / 100; }

function getTaskWithParts(taskId) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task) return null;
  const parts = db.prepare('SELECT * FROM sub_tasks WHERE task_id = ? ORDER BY id ASC').all(taskId);
  return { ...task, splittable: !!task.splittable, parts };
}

// POST /api/tasks
// Body:
//   title, description, category, total_amount,
//   splittable (bool), parts: [{ title, description, percentage }]
// If splittable=false, exactly one part is created at 100% (auto-generated if not supplied).
function createTask(req, res) {
  const b = req.body || {};
  const title = String(b.title || '').trim();
  const description = String(b.description || '').trim();
  const category = String(b.category || '').trim();
  const totalAmount = Number(b.total_amount);
  const splittable = !!b.splittable;
  const partsInput = Array.isArray(b.parts) ? b.parts : [];

  if (!title) return res.status(400).json({ error: 'title required' });
  if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
    return res.status(400).json({ error: 'total_amount must be positive' });
  }

  let parts;
  if (splittable) {
    if (partsInput.length < 1) return res.status(400).json({ error: 'splittable task requires at least one part' });
    const pcts = partsInput.map(p => Number(p.percentage));
    if (pcts.some(p => !Number.isFinite(p) || p <= 0 || p > 100)) {
      return res.status(400).json({ error: 'each part percentage must be in (0, 100]' });
    }
    const sum = pcts.reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 100) > 0.01) {
      return res.status(400).json({ error: `part percentages must sum to 100 (got ${sum})` });
    }
    parts = partsInput.map((p, i) => ({
      title: String(p.title || `Part ${i + 1}`).trim(),
      description: String(p.description || '').trim(),
      percentage: pcts[i],
      amount: round2(totalAmount * pcts[i] / 100),
    }));
  } else {
    parts = [{
      title: title,
      description: description,
      percentage: 100,
      amount: round2(totalAmount),
    }];
  }

  // Atomically: debit payer wallet, insert task + parts, record escrow tx.
  const tx = db.transaction(() => {
    wallet.adjustBalance(req.user.id, -totalAmount);
    const info = db.prepare(
      `INSERT INTO tasks (payer_id, title, description, category, total_amount, splittable, status)
       VALUES (?, ?, ?, ?, ?, ?, 'open')`
    ).run(req.user.id, title, description, category, round2(totalAmount), splittable ? 1 : 0);
    const taskId = info.lastInsertRowid;
    const insertPart = db.prepare(
      `INSERT INTO sub_tasks (task_id, title, description, percentage, amount)
       VALUES (?, ?, ?, ?, ?)`
    );
    for (const p of parts) insertPart.run(taskId, p.title, p.description, p.percentage, p.amount);
    wallet.recordTx(req.user.id, -totalAmount, 'escrow_hold', { task_id: taskId, note: 'Funds held in escrow' });
    return taskId;
  });

  try {
    const id = tx();
    res.json({ task: getTaskWithParts(id) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}

// GET /api/tasks?mine=1 lists tasks the user is involved in (as payer or taker).
// Without mine, returns open tasks filtered against the user's preferences.
function listTasks(req, res) {
  const mine = req.query.mine === '1' || req.query.mine === 'true';
  if (mine) {
    const asPayer = db.prepare('SELECT * FROM tasks WHERE payer_id = ? ORDER BY id DESC').all(req.user.id);
    const asTakerParts = db.prepare(
      `SELECT t.* FROM tasks t
       JOIN sub_tasks s ON s.task_id = t.id
       WHERE s.taker_id = ?
       GROUP BY t.id
       ORDER BY t.id DESC`
    ).all(req.user.id);
    const seen = new Set();
    const merged = [];
    for (const t of [...asPayer, ...asTakerParts]) {
      if (!seen.has(t.id)) { seen.add(t.id); merged.push(t); }
    }
    return res.json({ tasks: merged.map(t => getTaskWithParts(t.id)) });
  }

  // Browse open tasks. Apply preference filters if the user has them set,
  // unless ?ignorePrefs=1 is passed.
  const ignorePrefs = req.query.ignorePrefs === '1' || req.query.ignorePrefs === 'true';
  const prefs = ignorePrefs ? {} : safeJson(req.user.preferences);

  let sql = `SELECT t.* FROM tasks t WHERE t.status IN ('open','in_progress') AND t.payer_id != ?`;
  const params = [req.user.id];

  if (prefs.categories && Array.isArray(prefs.categories) && prefs.categories.length) {
    sql += ` AND t.category IN (${prefs.categories.map(() => '?').join(',')})`;
    params.push(...prefs.categories);
  }
  if (Number.isFinite(prefs.min_budget)) { sql += ' AND t.total_amount >= ?'; params.push(prefs.min_budget); }
  if (Number.isFinite(prefs.max_budget)) { sql += ' AND t.total_amount <= ?'; params.push(prefs.max_budget); }

  sql += ' ORDER BY t.id DESC LIMIT 200';
  let rows = db.prepare(sql).all(...params);

  // Keyword filter in JS (small dataset).
  if (prefs.keywords && Array.isArray(prefs.keywords) && prefs.keywords.length) {
    const kws = prefs.keywords.map(k => String(k).toLowerCase()).filter(Boolean);
    if (kws.length) {
      rows = rows.filter(t => {
        const hay = `${t.title} ${t.description}`.toLowerCase();
        return kws.some(k => hay.includes(k));
      });
    }
  }

  // Filter to tasks that still have at least one open sub_task.
  const result = [];
  for (const t of rows) {
    const full = getTaskWithParts(t.id);
    if (full.parts.some(p => p.status === 'open')) result.push(full);
  }
  res.json({ tasks: result });
}

// GET /api/tasks/:id
function getTask(req, res) {
  const t = getTaskWithParts(Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'Task not found' });
  res.json({ task: t });
}

// POST /api/tasks/:id/claim
// Body: { sub_task_id?: number, whole?: bool }
// - For non-splittable tasks, claims the single part.
// - For splittable tasks: pass sub_task_id to claim one part, or whole=true to
//   claim ALL currently-open parts at once.
function claimTask(req, res) {
  const taskId = Number(req.params.id);
  const task = getTaskWithParts(taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (task.payer_id === req.user.id) return res.status(400).json({ error: 'Cannot claim your own task' });
  if (task.status === 'completed' || task.status === 'cancelled') {
    return res.status(400).json({ error: `Task is ${task.status}` });
  }

  const subId = req.body && req.body.sub_task_id != null ? Number(req.body.sub_task_id) : null;
  const whole = !!(req.body && req.body.whole);

  let targets;
  if (whole) {
    targets = task.parts.filter(p => p.status === 'open');
    if (!targets.length) return res.status(400).json({ error: 'No open parts to claim' });
  } else if (subId != null) {
    const part = task.parts.find(p => p.id === subId);
    if (!part) return res.status(404).json({ error: 'Sub-task not found' });
    if (part.status !== 'open') return res.status(400).json({ error: 'Sub-task not open' });
    targets = [part];
  } else if (!task.splittable) {
    targets = task.parts.filter(p => p.status === 'open');
    if (!targets.length) return res.status(400).json({ error: 'No open parts to claim' });
  } else {
    return res.status(400).json({ error: 'sub_task_id or whole=true required for splittable task' });
  }

  const tx = db.transaction(() => {
    const upd = db.prepare(`UPDATE sub_tasks SET taker_id = ?, status = 'claimed' WHERE id = ? AND status = 'open'`);
    for (const p of targets) {
      const r = upd.run(req.user.id, p.id);
      if (r.changes !== 1) throw new Error('Sub-task no longer available');
    }
    db.prepare(`UPDATE tasks SET status = 'in_progress' WHERE id = ? AND status = 'open'`).run(taskId);
  });

  try { tx(); }
  catch (e) { return res.status(409).json({ error: e.message }); }

  res.json({ task: getTaskWithParts(taskId) });
}

// POST /api/sub_tasks/:id/submit
// Body: { submission: string }
// Runs AI validation. On pass: pays the taker from escrow and marks part validated.
// On fail: marks rejected and reopens the part.
async function submitSubTask(req, res) {
  const subId = Number(req.params.id);
  const part = db.prepare('SELECT * FROM sub_tasks WHERE id = ?').get(subId);
  if (!part) return res.status(404).json({ error: 'Sub-task not found' });
  if (part.taker_id !== req.user.id) return res.status(403).json({ error: 'Not your sub-task' });
  if (part.status !== 'claimed' && part.status !== 'rejected') {
    return res.status(400).json({ error: `Sub-task is ${part.status}` });
  }

  const submission = String((req.body && req.body.submission) || '').trim();
  if (!submission) return res.status(400).json({ error: 'submission text required' });

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(part.task_id);
  if (!task) return res.status(404).json({ error: 'Parent task missing' });

  let result;
  try {
    result = await validate({
      taskTitle: task.title,
      taskDescription: `${task.description}\n\nPart: ${part.title}\n${part.description}`,
      submission,
    });
  } catch (e) {
    return res.status(500).json({ error: 'Validation failed: ' + e.message });
  }

  const finalize = db.transaction(() => {
    if (result.passed) {
      db.prepare(
        `UPDATE sub_tasks SET status = 'validated', submission = ?, validation_result = ? WHERE id = ?`
      ).run(submission, JSON.stringify(result), subId);
      // Pay out escrow to taker.
      wallet.adjustBalance(req.user.id, part.amount);
      wallet.recordTx(req.user.id, part.amount, 'escrow_release', {
        task_id: task.id, sub_task_id: subId, note: 'Payout for validated sub-task',
      });
      // If all parts validated, mark task completed.
      const remaining = db.prepare(
        `SELECT COUNT(*) AS c FROM sub_tasks WHERE task_id = ? AND status != 'validated'`
      ).get(task.id).c;
      if (remaining === 0) {
        db.prepare(`UPDATE tasks SET status = 'completed' WHERE id = ?`).run(task.id);
      }
    } else {
      db.prepare(
        `UPDATE sub_tasks SET status = 'rejected', submission = ?, validation_result = ? WHERE id = ?`
      ).run(submission, JSON.stringify(result), subId);
    }
  });
  finalize();

  res.json({ result, sub_task: db.prepare('SELECT * FROM sub_tasks WHERE id = ?').get(subId) });
}

// PUT /api/preferences  — update taker preferences.
function updatePreferences(req, res) {
  const b = req.body || {};
  const prefs = {};
  if (Array.isArray(b.categories)) prefs.categories = b.categories.map(String).slice(0, 20);
  if (Array.isArray(b.keywords)) prefs.keywords = b.keywords.map(String).slice(0, 20);
  if (b.min_budget != null) {
    const n = Number(b.min_budget);
    if (Number.isFinite(n) && n >= 0) prefs.min_budget = n;
  }
  if (b.max_budget != null) {
    const n = Number(b.max_budget);
    if (Number.isFinite(n) && n >= 0) prefs.max_budget = n;
  }
  db.prepare('UPDATE users SET preferences = ? WHERE id = ?').run(JSON.stringify(prefs), req.user.id);
  res.json({ preferences: prefs });
}

function getPreferences(req, res) {
  res.json({ preferences: safeJson(req.user.preferences) });
}

module.exports = {
  createTask, listTasks, getTask, claimTask, submitSubTask,
  updatePreferences, getPreferences, getTaskWithParts,
};
