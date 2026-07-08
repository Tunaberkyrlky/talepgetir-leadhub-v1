# TG-LinkedIn — Faz 0 Build Spec — Adversarial Critique

> Reviewer verdict: **Buildable as written.** No hard build-blocker (P0 = 0). The spec is
> unusually accurate — every load-bearing claim I checked against the live codebase held:
> migration number (`083` is correct; highest is `082`), worker claims **all** job types
> (no `types` restriction in `worker/index.ts`), `research_claim_job` mints both `locked_by`
> and `lease` (062:496), `enqueueJob` `projectId` is optional, `JobHandler` contract matches,
> `validateBody`/`uuidField`/`requireRole`/`researchSupabaseAdmin`/`showSuccess`/`showErrorFromApi`
> all exported, deny-all RLS keeps `*_enc` off PostgREST, all `.js` import specifiers resolve,
> and the i18n anchors + `trade` values are exact. Findings below are correctness (P1) and
> polish/Faz-1-readiness (P2), not blockers.
>
> Verified live: `queue.ts`, `worker/index.ts`, `worker/types.ts`, `validation.ts`,
> `middleware/auth.ts`, `sanitize.ts`, `routes/research/jobs.ts`, `index.ts` mount order
> (lines 167/187–197/200–224), migration 062 claim RPC, `.env.example` (ENCRYPTION_KEY L67),
> `notifications.tsx`, `ResearchPage.tsx` (L12/19/123/132), `en.json`/`tr.json` (L514).

**Severity tally: P0 = 0 · P1 = 3 · P2 = 8**

---

## P0 — Build blockers

**None found.** The 16-file plan compiles and runs given the two Railway secrets
(`LINKEDIN_COOKIE_ENC_KEY`, `ROTATING_5G_PROXY`) are set and `undici` is installed. The
crypto/proxy/route import paths, the deny-all migration, and the worker no-op are all correct.

The one thing that *would* become a P0 if mishandled — the migration's hard dependency on
`research_jobs` (055), `update_updated_at()` (001), `tenants`, and `auth.users` existing in the
target DB — is real but the spec's VERIFY #1 catches it (see P2-e). On the current Model-A
research DB (== CRM project) all four are present, so `083` applies cleanly.

---

## P1 — Correctness

### P1-1 — Reserved `linkedin:*` constants become enqueuable-but-unhandled via the shared generic enqueue endpoint
**File:** `server/src/lib/research/jobTypes.ts` (spec §6) + `server/src/routes/research/jobs.ts:43`

The spec adds **six** LinkedIn constants (`LINKEDIN_VALIDATE` + 5 reserved: `invite`, `message`,
`poll`, `sequence-tick`, `withdraw`) to `RESEARCH_JOB_TYPES`. That auto-widens
`RESEARCH_JOB_TYPE_VALUES` / `isKnownJobType`. But the **existing** generic route
`POST /api/research/jobs` gates purely on `isKnownJobType(type)` (verified `jobs.ts:43`) and then
`enqueueJob`s anything that passes. So the moment these constants land, **any authenticated writer
can enqueue `linkedin:invite`/`message`/`poll`/… with no registered handler** → the worker claims
it → `getHandler()` returns `undefined` → runner fails "No handler registered" → retries 3× (default
`maxAttempts`) with backoff → permanently `failed`. Pure noise + wasted worker cycles, in prod, on
day one. Worse, `linkedin:validate` also becomes enqueuable **via `/api/research/jobs`**, bypassing
the ownership + `requireWriter` guards the `/api/linkedin` route wraps around it (the handler's
tenant-scoped account load blocks cross-tenant data, but the intended surface is skipped).

**Fix:** In Faz 0 add **only** `LINKEDIN_VALIDATE`; add each reserved constant in the Faz that ships
its handler. OR (defense-in-depth) gate the generic enqueue on `registeredJobTypes()` instead of
`isKnownJobType()`, so a known-but-unregistered type is rejected with 400.

### P1-2 — `capture.ts` re-auth UPDATE never checks it affected a row (silent 0-row success)
**File:** `server/src/routes/linkedin/capture.ts` (spec §10, the `if (existingAccountId)` branch)

The re-auth branch does `.update({...}).eq('id', existingAccountId).eq('tenant_id', tenantId)`
**without `.select()`**. Supabase returns `error: null` even when **zero rows match** (foreign
`account_id`, or the account was deleted between token-issue and capture). The code then treats it as
success: sets `accountId = existingAccountId`, writes a `linkedin_actions` audit row, enqueues
`linkedin:validate`, and returns **`201 { ok: true }`** to the extension — for an account it never
actually wrote. The `tenant_id` guard prevents a *cross-tenant write* (good), but the caller gets a
false success, an orphan audit row lands, and validate later fails "account not found".

Root cause is shared with the token issuer: **`POST /accounts/link-token` (spec §9) inserts
`account_id` from the request body without verifying it belongs to `req.tenantId`.** A tenant-A
writer can mint a token carrying tenant-B's `account_id`.

**Fix:** (a) In `link-token`, if `account_id` is present, verify it exists for `req.tenantId`
(`.eq('id').eq('tenant_id')` → 404 if missing) before issuing. (b) In capture's re-auth UPDATE, add
`.select('id').maybeSingle()` and return 404/409 when it matches nothing instead of proceeding.

### P1-3 — Partial unique index seeds a hard Faz-1 failure (validate does a plain UPDATE, not an upsert/merge)
**File:** `supabase/migrations/083_linkedin_foundation.sql` (spec §2, `uq_linkedin_accounts_tenant_urn`)

`CREATE UNIQUE INDEX ... ON linkedin_accounts(tenant_id, member_urn) WHERE member_urn IS NOT NULL`
is correct isolation, but at **capture** time `member_urn` is `NULL`, so the capture flow can create
**unlimited duplicate accounts** for one identity (two "new connection" tokens → two ACTIVE rows,
both `member_urn = NULL`). The Faz-1 validate handler's TODO says *"UPDATE linkedin_accounts SET …
member_urn"* — a plain UPDATE. The **second** account to validate to the same real identity will hit
the unique index → `23505` → the job throws → account is stuck in limbo with no graceful
"already connected to this workspace" path. The critique brief explicitly asks about "dedupe
uniqueness per tenant"; Faz 0 plants the constraint but Faz 1 has no collision strategy.

**Fix (decide now, document in the spec):** either (a) pre-check `member_urn` before the validate
UPDATE and, on collision, mark the dup `RESTRICTED`/delete it + surface "already connected"; or
(b) make the validate write an idempotent upsert on `(tenant_id, member_urn)` that folds the dup into
the canonical row. Add this to the Faz-1 handler contract so it isn't discovered at smoke time.

---

## P2 — Polish / Faz-1 readiness / convention notes

- **P2-a — Client panel polls forever for a captured-but-never-validated account.**
  `LinkedInAccountsPanel.tsx` (spec §14) `refetchInterval` returns 3000ms while any account is
  `status==='ACTIVE' && !last_validated_at`. The **Faz-0 stub validate never sets `last_validated_at`**
  (it only inserts a `skipped` action). So if the capture flow is exercised before Faz 1 (possible via
  curl even without the extension), that account triggers **infinite 3s polling**. Harmless until
  Faz 1 fleshes out validate, but note it. Moot only because Faz 0 ships no extension.

- **P2-b — Convention drift: LinkedIn routes echo raw rows without `sanitizeJobForRole`.**
  Every research route runs enqueue/job echoes through `sanitizeJobForRole` (harvest.ts:145, jobs.ts:75).
  The spec's `POST /:id/validate` does a plain `res.status(202).json(job)`. **Safe today** —
  `research_jobs` has no cost columns and a fresh validate job's `result` is null — but it's a
  divergence, and if any LinkedIn job later stashes `cogs_usd` in `job.result`, this route leaks it to
  `client_admin`. Cheap to wrap now for parity.

- **P2-c — Scope drift vs. strategy §9.** Strategy §9 places "cookie capture → encrypted store →
  validate → panel" in **Faz 1**; the spec pulls the working capture endpoint, `crypto.ts`, `proxy.ts`,
  `undici`, and the Mantine panel into **Faz 0** (only the real voyager call + the MV3 extension stay in
  Faz 1). This is a defensible "server skeleton ready so Faz 1 is just extension + real validate" choice
  and is internally documented (§0, §19) — but §9 of the strategy doc still says otherwise. Reconcile the
  wording so the Faz 0/1 boundary is stated once.

- **P2-d — `linkedinCaptureLimiter` (20/min) is additive, not a replacement.** `app.use('/api', generalLimiter)`
  (index.ts:167, 300/min) already blankets `/api/linkedin/capture`; the dedicated limiter stacks on top.
  Fine, just don't assume it's the only bucket.

- **P2-e — Migration cross-DB dependency + Model-A ambiguity.** `083` hard-requires `research_jobs(055)`,
  `update_updated_at()(001)`, `tenants`, `auth.users` in the target DB (FK `job_id → research_jobs`). If the
  research DB is the **same** Supabase project as CRM prod (Model A, per the secrets map's
  `researchSupabaseAdmin` fallback), applying `083` creates the `linkedin_*` tables in **prod** — harmless
  (empty, deny-all) but confirm intent. Spec VERIFY #1 covers the FK presence; add an explicit "same project
  as CRM? yes/no" check.

- **P2-f — Deep-link origin can be relative.** `link-token` builds
  `${LINKEDIN_APP_ORIGIN || CLIENT_URL || ''}/linkedin/connect#token=…`. If both env vars are unset the URL
  is relative; the extension may not resolve it. Fail louder or require one of the two.

- **P2-g — JSESSIONID stored with surrounding quotes.** Capture stores `jsessionid` verbatim
  (`"ajax:…"`). The §4.1 golden recipe needs `csrf-token: <JSESSIONID value>` — Faz 1 must **strip the
  quotes** when deriving the header. Column is fine; note it in the Faz-1 validate TODO.

- **P2-h — i18n edits are trailing-comma-sensitive.** Both `en.json`/`tr.json` edits append after
  `"trade": …` inside `research.tabs` and insert a `research.linkedin` sibling next to the existing
  `research.trade` object (en/tr line 516). A stray/missing comma breaks JSON parse for the whole app. The
  spec's VERIFY note flags it — keep the verification step. Key shapes are otherwise identical across both
  files and every `t()` call has an English fallback default.

---

## What is provably correct (so it isn't re-litigated)

- Migration number **083** is right (082 is highest; research 055–078, coldcall 079–082).
- Worker **claims all types** — `worker/index.ts:26` constructs `ResearchWorker` with no `types`, so
  `research_claim_job(p_types = NULL)` picks up `linkedin:validate` after redeploy. Real no-op edit.
- **Handler contract** matches `JobHandler` / `HandlerContext` exactly; stub returns a JSON summary, throws
  to fail, tenant-scopes its write, uses `researchSupabaseAdmin`.
- **Claim mints `locked_by` + `lease`** (062:496) so the stub's fence assertions never false-throw.
- **Deny-all RLS** (ENABLE + zero policies) mirrors `079_coldcall_core`; `*_enc` columns are structurally
  unreachable via any client JWT; `SAFE_COLUMNS` excludes them; API never echoes them. **Encrypted cookies
  cannot reach a client.**
- **Crypto** is fail-closed (AppError 500, no dev fallback), correct AES-256-GCM blob format, separate
  `LINKEDIN_COOKIE_ENC_KEY` domain. **Link token** is single-use (atomic `used_at IS NULL AND expires_at > now`
  UPDATE), SHA-256 hashed, 15-min expiry, raw returned once. Solid.
- **Capture `tenant_id` derives from the claimed token row**, not `req.tenantId` (correct — none pre-auth);
  all other writes `.eq('tenant_id', req.tenantId)`.
- **Mount order** works: public `/api/linkedin/capture` (pre-auth, L~197) registered before protected
  `/api/linkedin` (post-auth, L~220); Express serves the specific public path first and it responds without
  `next()`. No global `authMiddleware`.
- **i18n** en+tr are complete and shape-identical for every panel key.
- All **`.js` import specifiers** resolve; `zod/v4`, `researchSupabaseAdmin`, `enqueueJob`, `requireRole`,
  `validateBody`, `uuidField`, `createLogger` (at `server/src/lib/logger.ts`) all correct.
