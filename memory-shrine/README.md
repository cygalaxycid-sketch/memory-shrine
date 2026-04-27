# Task Marketplace (v1)

A small full-stack web application where **payers** post tasks and **takers**
claim and execute them. Payments are handled by an in-app **virtual wallet**
(no real money in v1), and task completion is checked by an **AI-driven
validator**.

## Features

1. **Email + password auth** — register and log in (JWT-based).
2. **Payer creates tasks** — title, description, category, total amount.
   At creation the payer chooses whether the task is **splittable**, and if so
   defines sub-tasks with **percentage shares** that must sum to 100%.
3. **Virtual wallet with escrow** — when a task is created the total amount is
   debited from the payer's wallet and held against the task. When a sub-task
   is validated, that part's amount is released to the taker.
4. **Taker preferences** — categories, keyword list, and min/max budget. The
   "Browse" list is filtered to tasks matching the preferences (with a toggle
   to ignore them).
5. **Claim a whole task or one of its splits** — for splittable tasks, the
   taker can claim a single percentage part or all open parts at once.
6. **AI-driven completion validation** — the taker submits a text deliverable;
   the server runs an AI validator and either pays out (validated) or rejects
   the submission (which can be revised and resubmitted).

   - If `OPENAI_API_KEY` is set, the validator calls OpenAI Chat Completions.
   - Otherwise, a deterministic rule-based fallback runs (length + keyword
     overlap with the task description).

## Architecture

- **Backend:** Node.js + Express, SQLite via `better-sqlite3` (file-based, no
  DB server needed). JWT auth, bcrypt password hashing.
- **Frontend:** Vanilla HTML/CSS/JS served as static files by the same server.
- **Storage:** SQLite database at `data/app.db`.

## Run locally

```bash
npm install
npm start
# open http://localhost:3000
```

Optional environment variables:

| Var              | Purpose                                         | Default                |
| ---------------- | ----------------------------------------------- | ---------------------- |
| `PORT`           | HTTP port                                       | `3000`                 |
| `DB_PATH`        | SQLite file path                                | `data/app.db`          |
| `JWT_SECRET`     | JWT signing secret (**override in production**) | `dev-secret-change-me` |
| `OPENAI_API_KEY` | Enables real AI validation                      | unset (rule-based)     |
| `OPENAI_MODEL`   | OpenAI model name                               | `gpt-4o-mini`          |

## Try the flow

1. Register two accounts in two browsers (or browser + private window):
   `payer@example.com` and `taker@example.com`.
2. As the payer: open **Wallet**, deposit e.g. `$200` (virtual).
3. As the payer: open **+ New Task**, fill in details, check
   **Allow this task to be split**, define two parts (e.g. 40% / 60%) and
   click **Create & Fund**. Funds move into escrow.
4. As the taker: open **Preferences**, set a matching category, save.
5. As the taker: open **Browse**, click **View & claim**, claim one part.
6. As the taker: submit a text deliverable that mentions the task keywords.
   The AI validator runs; on pass, that part's amount is credited to the
   taker's wallet. When all parts are validated, the parent task is marked
   completed.

## Tests

```bash
npm test
```

Runs an end-to-end smoke test (`test/smoke.test.js`) that exercises register,
login, deposit, task creation (split + non-split), browse with preferences,
claim, submit (failing + passing), payout, and task completion.

## API summary

```
POST  /api/auth/register     { email, password, name? }
POST  /api/auth/login        { email, password }
GET   /api/me

GET   /api/wallet
POST  /api/wallet/deposit    { amount }
GET   /api/wallet/transactions

GET   /api/preferences
PUT   /api/preferences       { categories?, keywords?, min_budget?, max_budget? }

POST  /api/tasks             { title, description?, category?, total_amount,
                               splittable, parts?: [{ title, description?, percentage }] }
GET   /api/tasks             # browse open tasks filtered by your preferences
GET   /api/tasks?mine=1      # tasks where you are payer or taker
GET   /api/tasks?ignorePrefs=1
GET   /api/tasks/:id

POST  /api/tasks/:id/claim   { sub_task_id?, whole? }
POST  /api/sub_tasks/:id/submit  { submission }
```

## Notes & limitations (v1)

- **Virtual money only.** No real payment processor, no KYC, no payouts.
- **Email is unverified** — anyone can register any email.
- **AI validation is naïve** — the rule-based fallback only checks length and
  keyword overlap and is intended as a placeholder; the OpenAI path is more
  realistic but still not a substitute for human review for high-value tasks.
- **No dispute / cancellation flow** in v1 (rejected submissions can be
  resubmitted; task creator cannot currently force-cancel and refund).
- **Single dual-role user** — every user can act as both payer and taker.
