// End-to-end smoke test for the task marketplace API.
// Uses a temp DB file so it doesn't touch the dev DB.
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-test-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.JWT_SECRET = 'test-secret';
process.env.DISABLE_RATE_LIMIT = '1';
delete process.env.OPENAI_API_KEY; // force rule-based validator

const app = require('../src/server');

function listen() {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function req(server, method, path, { token, body } = {}) {
  const port = server.address().port;
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

(async () => {
  const server = await listen();
  try {
    // 1) Register payer + taker
    const payerReg = await req(server, 'POST', '/api/auth/register', { body: { email: 'payer@example.com', password: 'secret123', name: 'Payer' } });
    assert.strictEqual(payerReg.status, 200, 'payer register');
    const payerToken = payerReg.data.token;

    const takerReg = await req(server, 'POST', '/api/auth/register', { body: { email: 'taker@example.com', password: 'secret123', name: 'Taker' } });
    assert.strictEqual(takerReg.status, 200, 'taker register');
    const takerToken = takerReg.data.token;

    // 2) Duplicate email rejected
    const dup = await req(server, 'POST', '/api/auth/register', { body: { email: 'payer@example.com', password: 'secret123' } });
    assert.strictEqual(dup.status, 409);

    // 3) Login works
    const login = await req(server, 'POST', '/api/auth/login', { body: { email: 'payer@example.com', password: 'secret123' } });
    assert.strictEqual(login.status, 200);

    // 4) Wrong password rejected
    const badLogin = await req(server, 'POST', '/api/auth/login', { body: { email: 'payer@example.com', password: 'wrong' } });
    assert.strictEqual(badLogin.status, 401);

    // 5) Payer deposits to wallet
    const dep = await req(server, 'POST', '/api/wallet/deposit', { token: payerToken, body: { amount: 200 } });
    assert.strictEqual(dep.status, 200);
    assert.strictEqual(dep.data.balance, 200);

    // 6) Cannot create task without enough funds
    const bigTask = await req(server, 'POST', '/api/tasks', { token: payerToken, body: { title: 'Too big', total_amount: 9999 } });
    assert.strictEqual(bigTask.status, 400);

    // 7) Create non-splittable task
    const nonSplit = await req(server, 'POST', '/api/tasks', { token: payerToken, body: {
      title: 'Write blog post about widgets',
      description: 'Need a 500-word blog post about widgets and gadgets',
      category: 'writing',
      total_amount: 50,
      splittable: false,
    }});
    assert.strictEqual(nonSplit.status, 200);
    assert.strictEqual(nonSplit.data.task.parts.length, 1);
    assert.strictEqual(nonSplit.data.task.parts[0].percentage, 100);

    // 8) Create splittable task with bad percentages → rejected
    const badSplit = await req(server, 'POST', '/api/tasks', { token: payerToken, body: {
      title: 'Bad', total_amount: 100, splittable: true,
      parts: [{ title: 'A', percentage: 50 }, { title: 'B', percentage: 30 }],
    }});
    assert.strictEqual(badSplit.status, 400);

    // 9) Create splittable task with valid percentages
    const split = await req(server, 'POST', '/api/tasks', { token: payerToken, body: {
      title: 'Build a small website',
      description: 'Design and code a small marketing website',
      category: 'coding',
      total_amount: 100,
      splittable: true,
      parts: [
        { title: 'Design mockups', description: 'Figma mockups for landing page', percentage: 40 },
        { title: 'Code the page', description: 'HTML/CSS/JS implementation', percentage: 60 },
      ],
    }});
    assert.strictEqual(split.status, 200, 'split create');
    const splitTask = split.data.task;
    assert.strictEqual(splitTask.parts.length, 2);
    assert.strictEqual(splitTask.parts[0].amount, 40);
    assert.strictEqual(splitTask.parts[1].amount, 60);

    // Payer balance should be 200 - 50 - 100 = 50
    const bal1 = await req(server, 'GET', '/api/wallet', { token: payerToken });
    assert.strictEqual(bal1.data.balance, 50);

    // 10) Taker sets preferences and browses
    await req(server, 'PUT', '/api/preferences', { token: takerToken, body: {
      categories: ['coding'], min_budget: 10, max_budget: 200, keywords: ['website'],
    }});
    const browse = await req(server, 'GET', '/api/tasks', { token: takerToken });
    assert.strictEqual(browse.status, 200);
    // Should match the splittable coding task, not the writing one
    assert.strictEqual(browse.data.tasks.length, 1);
    assert.strictEqual(browse.data.tasks[0].id, splitTask.id);

    // 11) Without preferences (ignorePrefs=1), both open tasks visible
    const browseAll = await req(server, 'GET', '/api/tasks?ignorePrefs=1', { token: takerToken });
    assert.strictEqual(browseAll.data.tasks.length, 2);

    // 12) Taker claims one sub-task of split task
    const claimOne = await req(server, 'POST', `/api/tasks/${splitTask.id}/claim`, {
      token: takerToken, body: { sub_task_id: splitTask.parts[0].id },
    });
    assert.strictEqual(claimOne.status, 200);
    const claimedTask = claimOne.data.task;
    assert.strictEqual(claimedTask.parts[0].status, 'claimed');
    assert.strictEqual(claimedTask.parts[0].taker_id, takerReg.data.user.id);
    assert.strictEqual(claimedTask.parts[1].status, 'open');
    assert.strictEqual(claimedTask.status, 'in_progress');

    // 13) Cannot claim same sub-task twice
    const claimAgain = await req(server, 'POST', `/api/tasks/${splitTask.id}/claim`, {
      token: takerToken, body: { sub_task_id: splitTask.parts[0].id },
    });
    assert.notStrictEqual(claimAgain.status, 200);

    // 14) Payer cannot claim own task
    const selfClaim = await req(server, 'POST', `/api/tasks/${splitTask.id}/claim`, {
      token: payerToken, body: { sub_task_id: splitTask.parts[1].id },
    });
    assert.strictEqual(selfClaim.status, 400);

    // 15) Taker submits short text → rule-based validator rejects
    const submitBad = await req(server, 'POST', `/api/sub_tasks/${splitTask.parts[0].id}/submit`, {
      token: takerToken, body: { submission: 'done' },
    });
    assert.strictEqual(submitBad.status, 200);
    assert.strictEqual(submitBad.data.result.passed, false);
    assert.strictEqual(submitBad.data.sub_task.status, 'rejected');

    // 16) Taker submits a relevant submission → validator passes, payout occurs
    const goodText = 'I have completed the design mockups for the small marketing website landing page. The Figma mockups include hero, features, and footer sections.';
    const submitGood = await req(server, 'POST', `/api/sub_tasks/${splitTask.parts[0].id}/submit`, {
      token: takerToken, body: { submission: goodText },
    });
    assert.strictEqual(submitGood.status, 200);
    assert.strictEqual(submitGood.data.result.passed, true, `expected pass, got: ${JSON.stringify(submitGood.data.result)}`);
    assert.strictEqual(submitGood.data.sub_task.status, 'validated');

    // Taker balance should now be 40 (the part amount)
    const takerBal = await req(server, 'GET', '/api/wallet', { token: takerToken });
    assert.strictEqual(takerBal.data.balance, 40);

    // 17) Parent task still in_progress because part 2 not done
    const taskMid = await req(server, 'GET', `/api/tasks/${splitTask.id}`, { token: takerToken });
    assert.strictEqual(taskMid.data.task.status, 'in_progress');

    // 18) Claim and complete second part → task becomes completed
    await req(server, 'POST', `/api/tasks/${splitTask.id}/claim`, {
      token: takerToken, body: { sub_task_id: splitTask.parts[1].id },
    });
    const goodText2 = 'Implementation is complete. I coded the marketing website landing page using HTML, CSS and JavaScript with responsive design.';
    const submitGood2 = await req(server, 'POST', `/api/sub_tasks/${splitTask.parts[1].id}/submit`, {
      token: takerToken, body: { submission: goodText2 },
    });
    assert.strictEqual(submitGood2.data.result.passed, true);

    const taskFinal = await req(server, 'GET', `/api/tasks/${splitTask.id}`, { token: takerToken });
    assert.strictEqual(taskFinal.data.task.status, 'completed');

    // Final taker balance: 40 + 60 = 100
    const takerBalFinal = await req(server, 'GET', '/api/wallet', { token: takerToken });
    assert.strictEqual(takerBalFinal.data.balance, 100);

    // 19) Non-splittable task: taker can claim without sub_task_id
    const claimNonSplit = await req(server, 'POST', `/api/tasks/${nonSplit.data.task.id}/claim`, {
      token: takerToken, body: {},
    });
    assert.strictEqual(claimNonSplit.status, 200);

    console.log('✓ All smoke tests passed');
  } finally {
    server.close();
  }
})().catch((e) => {
  console.error('✗ Smoke test failed:', e);
  process.exit(1);
});
