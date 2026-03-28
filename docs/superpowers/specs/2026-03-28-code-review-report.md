# Code Review Report — 2026-03-28

**Date:** 2026-03-28
**Scope:** 26 commits on `main` branch
**Reviewed by:** Claude Code (automated)
**Revision:** v2 — re-verified against current codebase

---

## Fixed Since Initial Review

### ~~Non-Atomic Stage Deactivation~~ FIXED

The `POST /settings/stages/:slug/deactivate` endpoint now uses `supabaseAdmin.rpc('deactivate_pipeline_stage', ...)` (`settings.ts:486-491`) which executes atomically inside a single PostgreSQL transaction. No longer a concern.

### ~~Activity Type Query Param Not Validated~~ FIXED

The `GET /activities` endpoint now validates the `type` query parameter against a `VALID_TYPES` whitelist (`activities.ts:46-51`), returning 400 for invalid values. Same validation added to `GET /activities/all` (`activities.ts:114-121`).

---

## Critical Issues (Score 100) — Still Present

### 1. client_admin Can Create Invisible Activities

**What:** After today's commits granted `client_admin` write access to `POST /activities` (`activities.ts:199`), the `ActivityForm` component unconditionally shows the `visibility: 'internal'` option to all roles. If a `client_admin` user selects "internal" visibility, the server accepts and persists the activity. However, `dataFilter.ts` middleware strips all `visibility: 'internal'` records from API responses for non-internal roles (`dataFilter.ts:36`). The activity becomes permanently invisible to the user who created it.

**Why:** The `ActivityForm` visibility selector (`ActivityForm.tsx:138-141`) renders two options (`client`, `internal`) without role checking. Before today, only `superadmin` and `ops_agent` could access `POST /activities` — both internal roles that bypass `dataFilter`. Commit `8ba1b29` added `client_admin` to `requireRole`, but neither the form nor the server restricts which visibility values non-internal roles can submit.

**How to fix:**

- **Option A (client-side):** In `ActivityForm.tsx`, filter visibility options based on role. Only show `internal` to users where `isInternal(role)` returns true.
- **Option B (server-side):** In `POST /activities`, reject `visibility: 'internal'` from non-internal callers with 422.
- **Recommended:** Apply both — client hides for UX, server enforces as safety net.

**Files:**
- `client/src/components/ActivityForm.tsx:138-141` — visibility options shown unconditionally
- `server/src/routes/activities.ts:199` — `client_admin` in `requireRole`
- `server/src/middleware/dataFilter.ts:36` — filters `internal` from non-internal roles

---

### 2. "Load More" Pagination in ActivityTimeline Is Broken

**What:** The `ActivityTimeline` component's "Load more" button increments a `page` state variable and the query fetches the next page. But the fetched data is never accumulated into the `allActivities` state array. The `shownList` derivation returns `allActivities` when `page > 1`, but nothing ever populates `allActivities`, so clicking "Load more" causes the displayed list to go empty.

**Why:** The component declares `page` (line 99) and `allActivities` (line 100). `shownList` (lines 127-130) returns `data.data` when `page === 1`, but returns `allActivities` for `page > 1`. The "Load more" button (line 296) calls `setPage((p) => p + 1)`. When the page increments, React Query fetches the next page, but there is no `useEffect` to append results into `allActivities`. The accumulator pattern was intended but never implemented.

**How to fix:**

Add a `useEffect` that appends new data into the accumulator:

```tsx
useEffect(() => {
    if (data?.data && page > 1) {
        setAllActivities((prev) => [...prev, ...data.data]);
    }
}, [data, page]);
```

Also seed `allActivities` with page 1 data when transitioning to page 2. Alternatively, refactor to use React Query's `useInfiniteQuery` which handles pagination accumulation natively.

**Files:**
- `client/src/components/ActivityTimeline.tsx:99-100` — `page` and `allActivities` state
- `client/src/components/ActivityTimeline.tsx:127-130` — `shownList` returns empty `allActivities` for page > 1
- `client/src/components/ActivityTimeline.tsx:296` — "Load more" increments page without accumulation

---

## Notable Issues (Score 75) — Still Present

### 3. Hardcoded Terminal Stage List in Bulk-Stage Endpoint

**What:** `server/src/routes/companies.ts:643` defines `const TERMINAL_STAGES_BULK = ['won', 'lost', 'on_hold', 'cancelled']` — a static list. The codebase already has `getTerminalStageSlugs(tenantId)` imported in the same file (line 10) but unused here.

**Why:** CLAUDE.md: "Pipeline stages: Per-tenant configuration stored in pipeline_stages table." If a tenant customizes terminal stages, this hardcoded list won't match.

**How to fix:** Replace with `await getTerminalStageSlugs(tenantId)`.

**Files:**
- `server/src/routes/companies.ts:643` — hardcoded `TERMINAL_STAGES_BULK`
- `server/src/routes/settings.ts:59-63` — existing dynamic function

---

### 4. Incomplete Contact Notes Removal

**What:** Today's commits removed notes endpoints and client UI, but left behind stale code:
- `contacts.ts:21-26` — `ContactNote` interface
- `contacts.ts:28-38` — `parseNotes()` helper
- `contacts.ts:226,263` — `POST /contacts` still destructures and persists `notes` from request body
- `contacts.ts:372-410` — translate endpoint still processes notes (`parseNotes` → translate → store `translations.notes`)

**Why:** The removal commits targeted standalone notes CRUD endpoints but missed the contact creation flow and translate endpoint. Notes can still be created via `POST /contacts` and translated via `POST /contacts/:id/translate`, but never viewed or managed.

**How to fix:** Remove `ContactNote`, `parseNotes`, notes block in translate handler, `notes` destructure in `POST /contacts`, and `contactNoteSchema` from `validation.ts`.

**Files:**
- `server/src/routes/contacts.ts:21-38` — stale interface and helper
- `server/src/routes/contacts.ts:226,263` — create handler still writes notes
- `server/src/routes/contacts.ts:372-410` — translate endpoint processes notes

---

### 5. DeactivateStageModal Allows Migration to Terminal Stages

**What:** `DeactivateStageModal.tsx:56-58` builds `targetOptions` from `allStages.filter((s) => s.is_active && s.slug !== stageSlug)` — includes terminal stages like `won`, `lost`, `on_hold`. This bypasses the `ClosingReportModal` flow that the drag-drop handler requires for terminal moves.

**Why:** `PipelinePage.tsx` intercepts drag-drops to terminal stages and routes through the closing report. The deactivation modal has no equivalent guard — neither client nor server blocks terminal targets.

**How to fix:** Filter terminal stages from `targetOptions` in the modal, and add server validation in `POST /stages/:slug/deactivate` to reject `stage_type: 'terminal'` as migration target.

**Files:**
- `client/src/components/DeactivateStageModal.tsx:56-58` — no terminal filter
- `server/src/routes/settings.ts:440-450` — server does not block terminal targets

---

### 6. Missing Error Handling on terminalQuery in Companies Route

**What:** `companies.ts:221`: `const { data: terminalData } = await terminalQuery` — `error` field not captured or checked. Every other query in the file checks errors.

**Why:** If terminalQuery fails, `terminalData` is `undefined`, terminal stage data silently disappears from the response.

**How to fix:** `const { data: terminalData, error: terminalError } = await terminalQuery;` + `if (terminalError) throw new AppError(...)`.

**Files:**
- `server/src/routes/companies.ts:221` — missing error check

---

### 7. isInternal Variable Uses Wrong Permission Check

**What:** `ActivityTimeline.tsx:105`: `const isInternal = hasRolePermission(user?.role || '', 'activity_write' as any)` checks `activity_write` which includes `client_admin` (`permissions.ts:33`). But `isInternal()` in `permissions.ts:52-54` only covers `superadmin` and `ops_agent`.

**Why:** The variable controls edit/delete menu visibility. Using `activity_write` grants `client_admin` these controls. The `as any` cast also suppresses type checking. If `client_admin` should have edit/delete, the variable should be renamed (e.g., `canEditActivities`). If not, use `isInternal(role)`.

**How to fix:** Rename to `canEditActivities` if intentional, or use `isInternal(user?.role)` if only internal roles should edit.

**Files:**
- `client/src/components/ActivityTimeline.tsx:105` — misleading name + `as any` cast
- `client/src/lib/permissions.ts:33,49-54` — `activity_write` vs `isInternal()` definitions
