# flows-hub

> Fork de [pageflows](https://github.com/lucasaugustodev/pageflows) customizado para testes E2E do **Portal Hub v2**.
> Adiciona actions HTTP/JWT/DB/audit, trace correlation e 6 flows pre-built do hub.
>
> **Deploy:** https://testes.somosahub.us

## Hub-specific changes (vs upstream pageflows)

| Aspecto | Upstream | flows-hub |
|---|---|---|
| Actions | só browser | + `http.request`, `http.assert_status`, `jwt.sign`, `audit.assert_entry`, `db.read` |
| Resolvers | mailtm, fake.cpf, static, eval | + `jwt.sign_admin`, `supabase.login` |
| Trace | screenshot, DOM | + correlation via `X-Trace-Id` linkado ao `audit_log` do hub |
| Cenários | user-built | + 6 flows pre-built em `flows/` (signup, adesão, MP, transferência, rescisão, admin CRUD) |
| Dashboard | upstream | + tabs **API Calls** e **Audit Log** no run detail |

Rebases do upstream: trimestralmente.

```bash
git fetch upstream
git rebase upstream/main
# resolver conflitos em src/actions.js, src/replay.js, src/resolvers.js
```

---

## Upstream pageflows

> Cloud browser automation. Record once, replay forever — with dynamic vars (OTP/CPF/fake data), an LLM agent that orchestrates your saved flows, and a web UI to run/share/inspect everything.

[**Sign up at pageflows.somosahub.us**](https://pageflows.somosahub.us/app/signup) · Internal beta · MIT-licensed source

We host the browsers (Chromium pool), the replay engine, the LLM agent, and the dashboard. You record flows and run them; we charge nothing while the platform is in internal beta.

> **Internal beta:** signup is currently restricted to `@somosahub.com.br` emails. New users get auto-added to all existing projects as editors. Set `SIGNUP_ALLOWED_DOMAIN=''` and `AUTO_SHARE_PROJECTS=false` if self-hosting for a different policy.

## What it does

```bash
# install the CLI (~50KB, no Chrome download)
git clone https://github.com/lucasaugustodev/pageflows.git
cd pageflows && npm link

# point at the cloud + sign up
pageflows config set url https://pageflows.somosahub.us
pageflows auth signup
pageflows project new "My App"

# record a flow (each command runs against a real browser in our cloud pool)
pageflows session new
pageflows goto https://app.example.com
pageflows fill 'input[type=email]' --as EMAIL static:'{"value":"alice@x.com"}'
pageflows toggle "Aceito os termos"          # smart checkbox: works on custom React components
pageflows dialog --accept "Aceitar termos"   # smart dialog: scrolls to enable confirm
pageflows save my-flow --var EMAIL=mailtm.new --assert url_contains=/dashboard

# replay it deterministically forever (zero LLM cost)
pageflows replay my-flow

# or override at run time
pageflows replay my-flow --var EMAIL=specific@email.com

# or let the agent figure out a NEW objective and save the result
pageflows agent run "test the password recovery flow on app.com and save it"
```

Open the [web dashboard](https://pageflows.somosahub.us/app/) to see your flows, run them with one click, watch live events, share runs publicly.

## Three layers, three costs

| Layer            | What it does                                                        | Cost / run     |
|------------------|---------------------------------------------------------------------|----------------|
| **Replay**       | Run a saved flow deterministically                                  | **$0**         |
| **Composition**  | Flows `invoke_flow` other flows; `when` for branching               | **$0**         |
| **Agent**        | LLM picks the right flow / fills gaps / saves new flows             | **~$0.005**    |

Run the agent once to chart a path, replay forever for free.

## Web UI

[`pageflows.somosahub.us/app/`](https://pageflows.somosahub.us/app/)

- **/projects** — your projects (you can be in multiple), create new, redeem invite codes
- **/p/:slug/flows** — list flows; click any to see vars/steps/assertions and **▶ Run** with per-var overrides
- **/p/:slug/runs** — history with status badges (passed/failed/running)
- **/p/:slug/runs/:id** — full run detail, screenshots inline, side-by-side with `/runs/<id>` (the public-shareable view)
- **/p/:slug/settings** — members, invite codes, project vars (credentials store), your API tokens

## Auth, projects, vars

```bash
pageflows auth signup           # email + password
pageflows auth login
pageflows auth me

pageflows tokens new ci         # named long-lived API token, shown only once
pageflows tokens list
pageflows tokens revoke <id>
pageflows usage                 # your replay/agent activity

pageflows project new "Hub Portal"
pageflows project list
pageflows project use hub-portal       # current project for all CLI commands
pageflows project invite --role editor # 12-char invite code
pageflows project join ABCD-EFGH-IJKL  # invitee redeems, becomes member
pageflows project members

# project vars — auto-merged into every replay as defaults
pageflows vars set TEST_EMAIL=alice@example.com
pageflows vars set TEST_PASSWORD='S3nh@!' --secret
pageflows vars list                    # secrets shown as ••••• (admin+ can use --reveal)
pageflows vars unset TEST_EMAIL
```

Roles: `viewer` (read-only) → `editor` (record + run) → `admin` (invite/remove members) → `owner` (delete project). The agent inherits project vars too — `pageflows agent run "log in and ..."` uses `TEST_EMAIL`/`TEST_PASSWORD` automatically.

## Recording

```bash
pageflows session new
pageflows goto https://app.example.com
pageflows snap                                  # peek at current page (NOT recorded)
pageflows fill 'input[type=email]' alice@x.com
pageflows click "Continue"

# Type real value, save as ${VAR} placeholder
pageflows fill 'input[placeholder="CPF"]' --as CPF fake.cpf

# Smart actions — robust to custom React components and tricky modals
pageflows toggle "Aceito os termos"
pageflows dialog --title "Termo" --accept "Aceitar"

pageflows save my-flow --var EMAIL=mailtm.new --var CPF=fake.cpf --assert url_contains=/dashboard
```

### Available actions

| Command                                         | What it does                                                       |
|-------------------------------------------------|--------------------------------------------------------------------|
| `pageflows goto <url>`                          | Navigate, wait for DOM                                             |
| `pageflows fill <css> <value>`                  | Type into input                                                    |
| `pageflows fill <css> --as VAR resolver`        | Type real value, save as `${VAR}` placeholder                      |
| `pageflows click <text>` / `--target <css>`     | Click by visible text or selector                                  |
| `pageflows toggle <label>` / `--off`            | Smart checkbox — handles custom React components                   |
| `pageflows dialog --accept <text>`              | Smart modal — scrolls to bottom, clicks accept                     |
| `pageflows select <css> <label>` / `--value v`  | Pick a `<select>` option                                           |
| `pageflows press <key>`                         | Keyboard key                                                       |
| `pageflows wait <selector>` / `wait ms <ms>`    | Wait until condition / time                                        |
| `pageflows snap [--json]`                       | Read current page (NOT recorded)                                   |
| `pageflows screenshot`                          | Save a screenshot                                                  |
| `pageflows mailtm new` / `wait <email>`         | Disposable inbox + OTP capture                                     |
| `pageflows eval "<js>"` / `--as VAR`            | Run JS in the page; `--as` stores the return value as a flow var   |
| `pageflows extract <css> --as VAR`              | Read DOM into a flow var (with optional `--transform`)             |
| `pageflows assert --actual <v> --expected <v>`  | Compare values; fails the step on mismatch                         |

## Replay engine

A flow is JSON: vars + steps + assertions. Every step can declare an `expect` post-condition.

```json
{
  "id": "my-signup",
  "vars": [
    { "name": "EMAIL",    "resolver": "mailtm.new" },
    { "name": "OTP",      "resolver": "mailtm.wait", "args": { "subject": "verify" } },
    { "name": "CPF",      "resolver": "fake.cpf" },
    { "name": "PASSWORD", "resolver": "static", "args": { "value": "Pw@2026!" } }
  ],
  "steps": [
    { "n": 1, "action": "goto",  "args": { "url": "https://app.example.com" } },
    { "n": 2, "action": "fill",  "args": { "target": "input[type=email]", "value": "${EMAIL}" } },
    { "n": 3, "action": "click", "args": { "text": "Continue" }, "expect": { "selector_visible": "input[name=otp]", "timeout": 15000 } },
    { "n": 4, "action": "wait_for_var", "args": { "var": "OTP" } },
    { "n": 5, "action": "fill",  "args": { "target": "input[name=otp]", "value": "${OTP}" } },
    { "n": 6, "action": "toggle","args": { "label": "Aceito os termos", "expectChecked": true } }
  ],
  "assertions": [
    { "type": "url_contains", "fragment": "/dashboard" }
  ]
}
```

Replay it:

```bash
pageflows replay my-signup
pageflows replay my-signup --var PASSWORD='MyOwn@2026!'   # override at run time
```

Live SSE events as it runs: `var_resolved`, `step_start`, `step_end`, `assertion`, `run_end`. The CLI prints the public viewer URL at the end (`pageflows.somosahub.us/runs/<id>`).

### Built-in resolvers

| Resolver       | Returns                                      | Args                                                            |
|----------------|----------------------------------------------|-----------------------------------------------------------------|
| `static`       | A fixed value                                | `{ value }`                                                     |
| `env`          | An environment variable                      | `{ name }`                                                      |
| `fake.cpf`     | A valid random Brazilian CPF (11 d.)         | —                                                               |
| `fake.phone`   | A valid Brazilian mobile (11 d.)             | —                                                               |
| `mailtm.new`   | A fresh disposable inbox at mail.tm          | `{ bind?: "default" }`                                          |
| `mailtm.bind`  | Re-authenticate to an existing mail.tm inbox | `{ email, password, bind? }`                                    |
| `mailtm.wait`  | OTP from the bound inbox                     | `{ bind?, subject?, from?, regex?, timeout?: 180 }`             |
| `api.fetch`    | HTTP GET/POST returning parsed JSON          | `{ url, method?, headers?, body?, json?, timeout? }`            |
| `prompt`       | Throws unless overridden via `--var`         | `{ name, question }`                                            |

Resolver args support `${VAR}` substitution from earlier-resolved vars **with nested-path access** — `${CFG.plans[0].installmentValue}` works, not just `${VAR}`.

### Config-aware testing (verify behavior matches truth)

Three primitives compose to verify the UI shows what an external config says it should:

```json
"vars": [
  { "name": "PLAN_CFG", "resolver": "api.fetch",
    "args": { "url": "https://admin.example.com/api/plans/missa-10",
              "headers": { "Authorization": "Bearer ${ADMIN_TOKEN}" } } }
],
"steps": [
  { "n": 1, "action": "invoke_flow", "args": { "flow": "drive-to-installments" } },
  { "n": 2, "action": "click",   "args": { "text": "21 parcelas" } },
  { "n": 3, "action": "extract", "args": {
      "selector": "[data-installment-21]",
      "as": "UI_VALUE",
      "transform": "currency"
  } },
  { "n": 4, "action": "eval",    "args": {
      "as": "EXPECTED",
      "script": "((${PLAN_CFG.basePrice} * (1 + ${PLAN_CFG.feeRate})) / 21).toFixed(2)"
  } },
  { "n": 5, "action": "assert_eq", "args": {
      "actual": "${UI_VALUE}",
      "expected": "${EXPECTED}",
      "compare": "numeric_equals",
      "tolerance": 0.05,
      "message": "parcela 21x deve igualar (basePrice × (1 + feeRate)) ÷ 21"
  } }
]
```

If the admin changes `feeRate` from 10% → 12% in the config, the test stays valid (calculates dynamically). If the frontend regresses and shows the wrong value, you get: `assert_eq failed: actual=141.40 expected=139.91`.

`assert_eq` modes: `equals`, `not_equals`, `equals_ignore_case`, `contains`, `regex_match`, `numeric_equals` (with `tolerance`).
`extract` transforms: `trim`, `lower`, `upper`, `int`, `float`, `currency` (handles "R$ 1.234,56"), `regex:<pattern>`.
`eval` accepts `{ as: 'VAR' }` to store the return value into the flow scope.

### Step expectations

Any step can declare `expect` for post-condition validation:

```json
{ "action": "click", "args": { "text": "Save" },
  "expect": { "url_contains": "/saved", "timeout": 10000 } }
```

Shapes: `url_contains`, `url_not_contains`, `text_appears`, `text_disappears`, `selector_visible`, `dialog_open`, `dialog_closed`. All accept optional `timeout`.

### Composition

```json
{
  "id": "my-full-flow",
  "vars": [{ "name": "MODE", "resolver": "static", "args": { "value": "skip" } }],
  "steps": [
    { "n": 1, "action": "invoke_flow", "args": { "flow": "my-signup" } },
    { "n": 2, "action": "invoke_flow", "args": { "flow": "my-onboarding" }, "when": "MODE != 'skip'" }
  ]
}
```

- `invoke_flow` runs another flow inside the same browser session.
- `when` is a tiny safe expression evaluator — `==`, `!=`, `>`, `<`, `&&`, `||`, `!`. No code execution.

### LLM auto-heal

When a step fails (selector timeout, etc), pageflows can fall back to a small LLM call: it sends the page snap + error and gets back a JS snippet that fixes the action. Saves a flow that used to be brittle. Triggers on `click`/`fill`/`toggle` failures by default.

## Autonomous agent

```bash
pageflows agent run "Sign up a new user, fill profile with fake data, stop on /dashboard. Save as 'my-app-signup'."
```

The agent:

1. Calls `list_flows` first (sees what's already recorded).
2. `invoke_flow`s every saved flow that fits — these run **for free** (deterministic).
3. Falls back to `goto`/`click`/`fill`/`toggle` only for parts not yet recorded.
4. On `finish(success=true, save_as=<id>)`, persists the recorded session as a new replayable flow.

**Model is locked to `deepseek/deepseek-v4-flash`** — proven cheapest reliable combo. A typical run with the orchestrator pattern (4-5 invoke_flow + a few snaps + finish) costs **~$0.005**. Same model handles replay's auto-heal (~$0.001/heal).

### Agent tools

`list_flows`, `invoke_flow`, `goto`, `snap`, `click`, `fill`, `toggle`, `select`, `press`, `wait_ms`, `wait_for_text`, `eval`, `mailtm_new`, `mailtm_wait`, `fake_cpf`, `fake_phone`, `finish`.

## Public run viewer

Every replay (and every agent run) gets a public, unguessable URL: `pageflows.somosahub.us/runs/<id>`.

Renders status, vars (secrets redacted), every step with screenshot, and assertions — no login required. Share with stakeholders, embed in tickets.

## Backup & export

```bash
pageflows flows export --to ./snapshot --with-vars   # snapshot
pageflows flows import ./snapshot                    # restore on another project
```

`scripts/backup.js` is a cron-friendly Node script for automated nightly backups to a private git repo.

## Architecture

```
        ┌───────────── pageflows CLI / Web UI ─────────────────┐
        │  recording • replay • agent loop • dashboard          │
        └──────────────────┬───────────────────────────────────┘
                           │ HTTPS  (X-API-Key + X-Project)
        ┌──────────────────▼───────────────────────────────────┐
        │  pageflows.somosahub.us (our cloud)                  │
        │  - auth, projects, members, invites                  │
        │  - project vars (credentials store)                  │
        │  - sessions + actions handler + recorder             │
        │  - flow store (SQLite)                               │
        │  - replay engine (vars, when, invoke_flow, expect,   │
        │    LLM auto-heal)                                    │
        │  - public run viewer + SSE event stream              │
        └──────────────────┬───────────────────────────────────┘
                           │ Playwright over WebSocket
        ┌──────────────────▼───────────────────────────────────┐
        │  Browserless OSS (Chromium pool)                     │
        └──────────────────────────────────────────────────────┘
```

## Self-hosting (advanced)

The whole stack is open-source. If you want to run it on your own infra (compliance, on-prem, fork), `docker compose up -d --build` brings everything up:

```bash
git clone https://github.com/lucasaugustodev/pageflows.git
cd pageflows
cp .env.example .env
# edit .env: API_KEYS=<legacy fallback shared key>
# optionally: OPENROUTER_API_KEY=sk-or-v1-... (for agent + LLM auto-heal)
docker compose up -d --build
```

API at `http://localhost:4100`, UI at `http://localhost:4100/app/`, Browserless at `http://localhost:3000`.

## Comparison

|                        | Playwright local | playwright-mcp | Browserbase ($) | **pageflows** |
|------------------------|------------------|----------------|-----------------|----------------|
| No infra to manage     | ❌                | ❌              | ✅               | ✅              |
| Auto-recorder + replay | manual           | ❌              | partial         | ✅              |
| OTP/email built-in     | ❌                | ❌              | ❌               | ✅              |
| Composable flows       | code             | ❌              | ❌               | ✅ `invoke_flow` |
| Smart selectors        | ❌                | ❌              | ❌               | ✅ `toggle`/`dialog`/auto-heal |
| Auth + multi-tenant    | ❌                | ❌              | ✅               | ✅ users/projects/roles |
| LLM agent built-in     | ❌                | ❌              | ❌               | ✅ `agent run`   |
| Web dashboard          | ❌                | ❌              | ✅               | ✅ `/app/`        |
| Public run sharing     | ❌                | ❌              | ✅               | ✅ `/runs/<id>`   |
| Free during beta       | n/a              | n/a            | ❌ (paid)        | ✅              |
| Open source / self-host| ✅                | ✅              | ❌               | ✅              |

## Status

**v0.4 (current)** — auth, projects, vars, smart actions, LLM auto-heal, web UI. Used in production against a real Brazilian formatura platform (Asaas-backed payments, multi-step contract creation with chargeback consent + 2FA OTP). Free during beta.

**Roadmap:**
- WebSocket live mode (server-push DOM events for tighter recording loop)
- Visual recorder in the web UI (record without the CLI)
- Usage dashboard with cost breakdown per project / per flow
- Schedule cron-style flow runs from the UI
- Paid tier (only when scale demands it)

## License

MIT.
