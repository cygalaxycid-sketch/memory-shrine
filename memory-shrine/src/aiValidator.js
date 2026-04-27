// AI-driven completion validation.
//
// If OPENAI_API_KEY is set, calls OpenAI to grade the submission against the
// task description. Otherwise falls back to a deterministic rule-based stub
// that approves submissions which (a) are at least 30 chars long and
// (b) share at least 2 meaningful keywords with the task description.
//
// The validator returns { passed: boolean, score: number 0..1, reason: string }.

const STOPWORDS = new Set([
  'the','and','for','with','this','that','from','your','have','will','about',
  'into','over','under','they','them','their','there','here','what','when',
  'where','which','while','also','just','than','then','been','being','were',
  'are','was','you','our','out','its','it\'s','some','any','all'
]);

function tokenize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w && w.length > 2 && !STOPWORDS.has(w));
}

function ruleBasedValidate({ taskTitle, taskDescription, submission }) {
  const text = (submission || '').trim();
  if (text.length < 30) {
    return { passed: false, score: 0.1, reason: 'Submission too short (under 30 characters).' };
  }
  const taskWords = new Set(tokenize(`${taskTitle} ${taskDescription}`));
  const subWords = new Set(tokenize(text));
  let overlap = 0;
  for (const w of subWords) if (taskWords.has(w)) overlap++;
  const denom = Math.max(1, Math.min(taskWords.size, 10));
  const score = Math.min(1, overlap / denom);
  if (overlap < 2) {
    return { passed: false, score, reason: `Submission shares only ${overlap} keyword(s) with the task.` };
  }
  return { passed: true, score, reason: `Submission shares ${overlap} keyword(s) with the task and meets length threshold.` };
}

async function openAiValidate({ taskTitle, taskDescription, submission }) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const prompt = `You are validating whether a freelancer's submission completes a task.\n\nTASK TITLE: ${taskTitle}\nTASK DESCRIPTION: ${taskDescription}\n\nSUBMISSION:\n${submission}\n\nRespond ONLY with strict JSON of the form {"passed": true|false, "score": number between 0 and 1, "reason": short string}.`;

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      response_format: { type: 'json_object' },
    }),
  });
  if (!resp.ok) throw new Error(`OpenAI error ${resp.status}`);
  const data = await resp.json();
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  const parsed = JSON.parse(content);
  return {
    passed: !!parsed.passed,
    score: typeof parsed.score === 'number' ? parsed.score : (parsed.passed ? 1 : 0),
    reason: String(parsed.reason || ''),
  };
}

async function validate(input) {
  if (process.env.OPENAI_API_KEY) {
    try {
      return await openAiValidate(input);
    } catch (e) {
      const r = ruleBasedValidate(input);
      return { ...r, reason: `[AI fallback: ${e.message}] ${r.reason}` };
    }
  }
  return ruleBasedValidate(input);
}

module.exports = { validate, ruleBasedValidate };
