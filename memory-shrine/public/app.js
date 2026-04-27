// Single-page frontend. Talks to the backend REST API.
const state = {
  token: localStorage.getItem('token') || null,
  user: null,
  view: 'login', // login | register | browse | mine | create | wallet | prefs | task
  taskId: null,
  flash: null,
};

const $ = (sel) => document.querySelector(sel);
const main = () => $('#main');
const nav = () => $('#nav');

function setFlash(msg, kind) {
  state.flash = msg ? { msg, kind: kind || 'success' } : null;
}

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
  const r = await fetch(path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}

function logout() {
  state.token = null; state.user = null;
  localStorage.removeItem('token');
  state.view = 'login';
  render();
}

async function refreshUser() {
  if (!state.token) return;
  try { state.user = (await api('/api/me')).user; }
  catch { logout(); }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

// ---------- Renderers ----------

function renderNav() {
  if (!state.user) { nav().innerHTML = ''; return; }
  nav().innerHTML = `
    <span style="margin-right:12px">${escapeHtml(state.user.email)} · $${state.user.wallet_balance.toFixed(2)}</span>
    <button onclick="go('browse')">Browse</button>
    <button onclick="go('mine')">My Tasks</button>
    <button onclick="go('create')">+ New Task</button>
    <button onclick="go('wallet')">Wallet</button>
    <button onclick="go('prefs')">Preferences</button>
    <button onclick="logout()">Logout</button>
  `;
}

function flashHtml() {
  if (!state.flash) return '';
  const cls = state.flash.kind === 'error' ? 'error' : 'success';
  const html = `<div class="${cls}">${escapeHtml(state.flash.msg)}</div>`;
  state.flash = null;
  return html;
}

function renderLogin() {
  main().innerHTML = `
    <div class="card">
      <div class="tabs">
        <button class="${state.view==='login'?'active':''}" onclick="go('login')">Login</button>
        <button class="${state.view==='register'?'active':''}" onclick="go('register')">Register</button>
      </div>
      ${flashHtml()}
      <div id="form-error" class="error"></div>
      <label>Email</label>
      <input id="email" type="email" autocomplete="email" />
      ${state.view === 'register' ? '<label>Name</label><input id="name" />' : ''}
      <label>Password</label>
      <input id="password" type="password" autocomplete="${state.view==='register'?'new-password':'current-password'}" />
      <div style="margin-top:14px"><button class="primary" onclick="submitAuth()">${state.view==='register'?'Create account':'Log in'}</button></div>
    </div>
  `;
}

async function submitAuth() {
  const email = $('#email').value.trim();
  const password = $('#password').value;
  const name = $('#name') ? $('#name').value.trim() : '';
  try {
    const path = state.view === 'register' ? '/api/auth/register' : '/api/auth/login';
    const body = state.view === 'register' ? { email, password, name } : { email, password };
    const data = await api(path, { method: 'POST', body });
    state.token = data.token; state.user = data.user;
    localStorage.setItem('token', state.token);
    setFlash('Welcome!', 'success');
    state.view = 'browse';
    render();
  } catch (e) {
    $('#form-error').textContent = e.message;
  }
}

async function renderBrowse() {
  main().innerHTML = `<div class="card"><h2>Open Tasks (matched to your preferences)</h2>${flashHtml()}<div id="list">Loading…</div><p><button class="secondary" onclick="renderBrowseAll()">Show all open tasks (ignore preferences)</button></p></div>`;
  try {
    const { tasks } = await api('/api/tasks');
    $('#list').innerHTML = tasks.length ? tasks.map(taskCardHtml).join('') : '<p>No open tasks match your preferences.</p>';
  } catch (e) { $('#list').innerHTML = `<div class="error">${escapeHtml(e.message)}</div>`; }
}

async function renderBrowseAll() {
  try {
    const { tasks } = await api('/api/tasks?ignorePrefs=1');
    $('#list').innerHTML = tasks.length ? tasks.map(taskCardHtml).join('') : '<p>No open tasks.</p>';
  } catch (e) { $('#list').innerHTML = `<div class="error">${escapeHtml(e.message)}</div>`; }
}

function taskCardHtml(t) {
  return `
    <div class="task">
      <h3>${escapeHtml(t.title)} <span class="status ${t.status}">${t.status}</span></h3>
      <div class="meta">
        ${t.category ? `<span class="tag">${escapeHtml(t.category)}</span>` : ''}
        Total: <span class="amount">$${t.total_amount.toFixed(2)}</span>
        · ${t.splittable ? `${t.parts.length} parts` : 'single part'}
      </div>
      <div>${escapeHtml(t.description).slice(0, 200)}${t.description.length>200?'…':''}</div>
      <div style="margin-top:8px"><button class="secondary" onclick="go('task', ${t.id})">View &amp; claim</button></div>
    </div>`;
}

async function renderMine() {
  main().innerHTML = `<div class="card"><h2>My Tasks</h2>${flashHtml()}<div id="list">Loading…</div></div>`;
  try {
    const { tasks } = await api('/api/tasks?mine=1');
    $('#list').innerHTML = tasks.length ? tasks.map(taskCardHtml).join('') : '<p>You have no tasks yet.</p>';
  } catch (e) { $('#list').innerHTML = `<div class="error">${escapeHtml(e.message)}</div>`; }
}

function renderCreate() {
  main().innerHTML = `
    <div class="card">
      <h2>Create a Task</h2>
      ${flashHtml()}
      <div id="form-error" class="error"></div>
      <label>Title</label><input id="title" />
      <label>Category (e.g. writing, design, coding)</label><input id="category" />
      <label>Description</label><textarea id="description"></textarea>
      <label>Total amount ($) — held in escrow from your wallet</label><input id="total_amount" type="number" min="0.01" step="0.01" />
      <label><input id="splittable" type="checkbox" onchange="toggleParts()" /> Allow this task to be split into multiple sub-tasks (each sub-task can be claimed by a different taker)</label>
      <div id="parts-section" class="hidden" style="margin-top:12px">
        <h3>Sub-tasks (percentages must sum to 100)</h3>
        <div id="parts"></div>
        <button class="secondary" onclick="addPart()">+ Add part</button>
      </div>
      <div style="margin-top:16px"><button class="primary" onclick="submitTask()">Create &amp; Fund</button></div>
    </div>
  `;
}

function toggleParts() {
  const on = $('#splittable').checked;
  $('#parts-section').classList.toggle('hidden', !on);
  if (on && !$('#parts').children.length) { addPart(); addPart(); }
}

function addPart() {
  const idx = $('#parts').children.length;
  const div = document.createElement('div');
  div.className = 'part';
  div.innerHTML = `
    <div class="row">
      <div><label>Title</label><input class="p-title" /></div>
      <div style="max-width:120px"><label>Percent</label><input class="p-pct" type="number" min="0.01" max="100" step="0.01" /></div>
      <div style="max-width:60px;display:flex;align-items:flex-end"><button class="secondary" onclick="this.closest('.part').remove()">×</button></div>
    </div>
    <label>Description</label><textarea class="p-desc"></textarea>
  `;
  $('#parts').appendChild(div);
}

async function submitTask() {
  const splittable = $('#splittable').checked;
  const body = {
    title: $('#title').value.trim(),
    category: $('#category').value.trim(),
    description: $('#description').value.trim(),
    total_amount: Number($('#total_amount').value),
    splittable,
    parts: [],
  };
  if (splittable) {
    body.parts = Array.from($('#parts').children).map(el => ({
      title: el.querySelector('.p-title').value.trim(),
      description: el.querySelector('.p-desc').value.trim(),
      percentage: Number(el.querySelector('.p-pct').value),
    }));
  }
  try {
    await api('/api/tasks', { method: 'POST', body });
    await refreshUser();
    setFlash('Task created and funds held in escrow.', 'success');
    state.view = 'mine';
    render();
  } catch (e) { $('#form-error').textContent = e.message; }
}

async function renderTask() {
  main().innerHTML = `<div class="card" id="task-card">Loading…</div>`;
  try {
    const { task } = await api(`/api/tasks/${state.taskId}`);
    const isPayer = task.payer_id === state.user.id;
    $('#task-card').innerHTML = `
      ${flashHtml()}
      <div id="form-error" class="error"></div>
      <h2>${escapeHtml(task.title)} <span class="status ${task.status}">${task.status}</span></h2>
      <div class="meta">
        ${task.category ? `<span class="tag">${escapeHtml(task.category)}</span>` : ''}
        Total: <span class="amount">$${task.total_amount.toFixed(2)}</span>
        · ${task.splittable ? 'Splittable' : 'Single deliverable'}
        · ${isPayer ? 'You are the payer' : 'You are not the payer'}
      </div>
      <p>${escapeHtml(task.description)}</p>
      <h3>Parts</h3>
      ${task.parts.map(p => partHtml(p, task, isPayer)).join('')}
      ${(!isPayer && task.splittable && task.parts.some(p=>p.status==='open')) ? `<p><button class="secondary" onclick="claim(${task.id}, null, true)">Claim ALL open parts</button></p>` : ''}
    `;
  } catch (e) { $('#task-card').innerHTML = `<div class="error">${escapeHtml(e.message)}</div>`; }
}

function partHtml(p, task, isPayer) {
  const isMine = p.taker_id === state.user.id;
  let actions = '';
  if (!isPayer && p.status === 'open') {
    actions = `<button class="secondary" onclick="claim(${task.id}, ${p.id})">Claim this part</button>`;
  } else if (isMine && (p.status === 'claimed' || p.status === 'rejected')) {
    actions = `
      <label>Submit your work (text deliverable)</label>
      <textarea id="sub-${p.id}"></textarea>
      <button class="primary" onclick="submitWork(${p.id})">Submit for AI validation</button>
    `;
  }
  let validation = '';
  if (p.validation_result) {
    try {
      const r = JSON.parse(p.validation_result);
      validation = `<div class="meta"><strong>AI validation:</strong> ${r.passed ? '✓ passed' : '✗ failed'} (score ${(r.score||0).toFixed(2)}). ${escapeHtml(r.reason||'')}</div>`;
    } catch {}
  }
  return `
    <div class="part">
      <strong>${escapeHtml(p.title)}</strong>
      <span class="status ${p.status}">${p.status}</span>
      <span class="meta"> · ${p.percentage}% = <span class="amount">$${p.amount.toFixed(2)}</span></span>
      ${p.description ? `<div style="margin-top:4px">${escapeHtml(p.description)}</div>` : ''}
      ${validation}
      ${p.submission ? `<div class="meta"><strong>Submission:</strong> ${escapeHtml(p.submission).slice(0,300)}</div>` : ''}
      <div style="margin-top:6px">${actions}</div>
    </div>
  `;
}

async function claim(taskId, subTaskId, whole) {
  try {
    const body = whole ? { whole: true } : { sub_task_id: subTaskId };
    await api(`/api/tasks/${taskId}/claim`, { method: 'POST', body });
    setFlash('Claimed.', 'success');
    render();
  } catch (e) { $('#form-error').textContent = e.message; }
}

async function submitWork(subId) {
  const submission = $(`#sub-${subId}`).value;
  try {
    const data = await api(`/api/sub_tasks/${subId}/submit`, { method: 'POST', body: { submission } });
    if (data.result.passed) setFlash(`AI validated ✓ — payout $${data.sub_task.amount.toFixed(2)} released.`, 'success');
    else setFlash(`AI rejected: ${data.result.reason}`, 'error');
    await refreshUser();
    render();
  } catch (e) { $('#form-error').textContent = e.message; }
}

async function renderWallet() {
  main().innerHTML = `
    <div class="card">
      <h2>Wallet</h2>
      ${flashHtml()}
      <div class="balance" id="bal">$${state.user.wallet_balance.toFixed(2)}</div>
      <div id="form-error" class="error"></div>
      <label>Virtual deposit amount</label>
      <div class="row">
        <input id="dep" type="number" min="0.01" step="0.01" placeholder="100" />
        <div style="max-width:140px"><button class="primary" onclick="deposit()">Deposit</button></div>
      </div>
      <small class="muted">v1: virtual money only — no real payment processor.</small>
      <h3 style="margin-top:24px">Recent transactions</h3>
      <div id="txs">Loading…</div>
    </div>
  `;
  try {
    const { transactions } = await api('/api/wallet/transactions');
    $('#txs').innerHTML = transactions.length ? transactions.map(t => `
      <div class="part">
        <span class="amount" style="color:${t.amount<0?'#c0392b':'#27ae60'}">${t.amount<0?'-':'+'}$${Math.abs(t.amount).toFixed(2)}</span>
        · ${escapeHtml(t.type)} ${t.task_id?`(task #${t.task_id})`:''}
        <div class="meta">${escapeHtml(t.note||'')} · ${escapeHtml(t.created_at)}</div>
      </div>
    `).join('') : '<p>No transactions yet.</p>';
  } catch (e) { $('#txs').innerHTML = `<div class="error">${escapeHtml(e.message)}</div>`; }
}

async function deposit() {
  const amount = Number($('#dep').value);
  try {
    await api('/api/wallet/deposit', { method: 'POST', body: { amount } });
    await refreshUser();
    setFlash('Deposit successful.', 'success');
    render();
  } catch (e) { $('#form-error').textContent = e.message; }
}

async function renderPrefs() {
  let prefs = {};
  try { prefs = (await api('/api/preferences')).preferences || {}; } catch {}
  main().innerHTML = `
    <div class="card">
      <h2>Taker Preferences</h2>
      ${flashHtml()}
      <div id="form-error" class="error"></div>
      <p>These filter the "Browse" list to tasks you'd actually want to take.</p>
      <label>Categories (comma-separated, e.g. writing,design,coding)</label>
      <input id="cats" value="${escapeHtml((prefs.categories||[]).join(','))}" />
      <label>Keywords (comma-separated, matched against title/description)</label>
      <input id="kws" value="${escapeHtml((prefs.keywords||[]).join(','))}" />
      <div class="row">
        <div><label>Min budget ($)</label><input id="minb" type="number" min="0" step="0.01" value="${prefs.min_budget != null ? prefs.min_budget : ''}" /></div>
        <div><label>Max budget ($)</label><input id="maxb" type="number" min="0" step="0.01" value="${prefs.max_budget != null ? prefs.max_budget : ''}" /></div>
      </div>
      <div style="margin-top:14px"><button class="primary" onclick="savePrefs()">Save</button></div>
    </div>
  `;
}

async function savePrefs() {
  const body = {
    categories: $('#cats').value.split(',').map(s => s.trim()).filter(Boolean),
    keywords: $('#kws').value.split(',').map(s => s.trim()).filter(Boolean),
  };
  if ($('#minb').value !== '') body.min_budget = Number($('#minb').value);
  if ($('#maxb').value !== '') body.max_budget = Number($('#maxb').value);
  try {
    await api('/api/preferences', { method: 'PUT', body });
    setFlash('Preferences saved.', 'success');
    render();
  } catch (e) { $('#form-error').textContent = e.message; }
}

// ---------- Router ----------

function go(view, taskId) {
  state.view = view;
  if (taskId != null) state.taskId = taskId;
  render();
}
window.go = go; window.logout = logout;
window.submitAuth = submitAuth; window.toggleParts = toggleParts;
window.addPart = addPart; window.submitTask = submitTask;
window.claim = claim; window.submitWork = submitWork;
window.deposit = deposit; window.savePrefs = savePrefs;
window.renderBrowseAll = renderBrowseAll;

async function render() {
  if (!state.token) {
    if (state.view !== 'login' && state.view !== 'register') state.view = 'login';
    renderNav();
    renderLogin();
    return;
  }
  if (!state.user) await refreshUser();
  if (!state.user) { renderNav(); renderLogin(); return; }
  renderNav();
  switch (state.view) {
    case 'browse': return renderBrowse();
    case 'mine': return renderMine();
    case 'create': return renderCreate();
    case 'task': return renderTask();
    case 'wallet': return renderWallet();
    case 'prefs': return renderPrefs();
    default: state.view = 'browse'; return renderBrowse();
  }
}

render();
