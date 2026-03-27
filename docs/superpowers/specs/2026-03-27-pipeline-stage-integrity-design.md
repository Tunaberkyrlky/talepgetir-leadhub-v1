# Pipeline Stage Referential Integrity & Deactivation Flow

**Date:** 2026-03-27
**Status:** Approved (v2 — post review)

## Problem

`companies.stage` is a free-text field with no foreign key to `pipeline_stages`. This means:
- A stage row can be deleted while companies still reference its slug, leaving orphaned values.
- Stage slugs are never renamed via the API, but there is no DB-level protection if done directly.
- No DB-level guarantee that a company's stage slug is valid for its tenant.

## Solution Overview

1. Add a composite FK from `companies(tenant_id, stage)` → `pipeline_stages(tenant_id, slug)`.
2. Replace the existing hard-delete stage behavior with a soft-delete (deactivate) flow that requires companies to be migrated first via a modal.
3. The FK makes hard deletion of a referenced stage impossible at the DB level, enforcing the soft-delete-first requirement.

---

## 1. Database Layer

### Composite FK

```sql
-- 015_pipeline_stage_fk.sql
-- Pre-flight guard: fail if orphaned stage values exist
DO $$
BEGIN
  ASSERT (
    SELECT COUNT(*) FROM companies c
    WHERE NOT EXISTS (
      SELECT 1 FROM pipeline_stages ps
      WHERE ps.tenant_id = c.tenant_id AND ps.slug = c.stage
    )
  ) = 0, 'Orphaned stage values found — fix before adding FK';
END $$;

ALTER TABLE companies
  ADD CONSTRAINT fk_companies_stage
  FOREIGN KEY (tenant_id, stage)
  REFERENCES pipeline_stages(tenant_id, slug)
  ON UPDATE CASCADE
  ON DELETE RESTRICT;
```

**ON UPDATE CASCADE:** If a slug is ever updated directly in the DB, companies cascade automatically. The application API intentionally does not expose slug renaming (only `display_name`, `color`, `sort_order` are editable), so CASCADE is defensive insurance for direct DB operations, not an active application feature.

**ON DELETE RESTRICT:** Hard deletion of a stage row is blocked at the DB level if any company references it. This enforces the deactivate-first workflow.

### Soft Delete

`pipeline_stages.is_active` (BOOLEAN, already present) is set to `false` to deactivate a stage. The row is retained, so the FK constraint remains satisfied.

**Initial stage protection:** Deactivating the `stage_type = 'initial'` stage is blocked at the server level (same policy as the existing DELETE endpoint which already blocks initial stage deletion).

---

## 2. Server Layer

New endpoints are added to `server/src/routes/settings.ts`, following the existing `isAdmin()` guard pattern (`superadmin`, `ops_agent`, `client_admin`).

### GET `/api/settings/stages/:slug/companies`

Returns companies currently assigned to a stage. Tenant isolation is enforced by scoping the query to `req.tenantId`.

**Response:**
```json
{
  "stage": { "id": "uuid", "slug": "qualified", "display_name": "Qualified", "stage_type": "pipeline" },
  "companies": [
    { "id": "uuid", "name": "Acme Corp" }
  ]
}
```

No pagination — this is an admin-only operation and the practical upper bound (all companies in one stage) is acceptable without it.

### POST `/api/settings/stages/:slug/deactivate`

Atomically migrates companies and soft-deletes the stage.

**Zod schema:**
```ts
const deactivateSchema = z.object({
  migrations: z.array(z.object({
    companyId: z.string().uuid(),
    targetStage: z.string().min(1),
  })),
});
```

**Server-side validation of migrations:**
- Each `targetStage` must exist in `pipeline_stages` for `req.tenantId` and be `is_active = true`.
- Each `targetStage` must not equal the stage being deactivated.
- Each `companyId` must belong to `req.tenantId`.

**Behavior (all steps in a single DB transaction via RPC or sequential supabaseAdmin calls):**
1. Apply explicit migrations: `UPDATE companies SET stage = targetStage WHERE id = companyId AND tenant_id = req.tenantId`.
2. Resolve the tenant's `stage_type = 'initial'` stage slug dynamically using `getTenantStages(tenantId)`.
3. Move any remaining companies still in this stage to the initial stage slug.
4. Set `pipeline_stages.is_active = false` for the target stage.
5. Call `invalidateStageCache(tenantId)`.
6. Write an audit log entry: `action: 'stage.deactivate'`, `targetType: 'pipeline_stage'`, `targetId: <stage UUID>` (not slug — matches existing convention in `logAuditAction`), `details: { slug, companiesMoved: N }`.

**Edge case:** If 0 companies are in this stage, steps 1–3 are skipped. Stage is deactivated immediately.

**Blocked cases (return 400):**
- Deactivating a `stage_type = 'initial'` stage.
- `targetStage` validation failure (nonexistent, inactive, or circular).

**Race condition:** If a `targetStage` is deactivated between the modal opening and the confirm click, step 1's DB write will fail the FK check or the server validation and return 422 with a descriptive error.

### Existing `DELETE /api/settings/stages/:slug` endpoint

After migration 015, calling this endpoint for a stage that still has companies will produce a raw Postgres FK violation (`23503`). This endpoint must be updated as part of this change:

- Catch FK error code `23503` and return `409 { error: "Stage has companies — use POST /api/settings/stages/:slug/deactivate" }`.
- Alternatively, the endpoint can be removed entirely since the new deactivate flow replaces its primary use case. The delete path (hard delete after soft deactivation) can remain accessible only for stages with 0 companies.

**Decision:** Keep the DELETE endpoint but add FK error handling so it returns a clear 409 instead of a 500 when called on a referenced stage.

### Auth

Both new endpoints use the existing `isAdmin()` check (`superadmin`, `ops_agent`, `client_admin`). They do **not** go under `/api/admin` (which is restricted to `superadmin` only).

---

## 3. Client Layer

### Trigger

Admin clicks "Deactivate" on a stage card in the Pipeline Settings UI. The Deactivate button is **not rendered** for `stage_type = 'initial'` stages (consistent with the existing editor which already hides the delete button for initial stages).

### Flow

1. Client calls `GET /api/settings/stages/:slug/companies`.
2. **0 companies:** calls `POST .../deactivate` with `{ migrations: [] }` directly — no modal.
3. **>0 companies:** opens a **Modal**:
   - **Title:** `"[Stage Name] aşamasını devre dışı bırak"`
   - **Company list:** scrollable table — each row: company name + `<Select>` dropdown for target stage.
     - Dropdown options: all `is_active = true` stages for this tenant, **excluding** the stage being deactivated.
   - **"Tümünü [Initial Stage]'e Taşı"** bulk action button at the top — sets all dropdowns to the tenant's `initial` stage. The initial stage slug is resolved from `useStages()` context (not hardcoded as `'cold'`).
   - **"Deactivate Et"** confirm button at the bottom:
     - **Disabled** while any company row has no target stage selected. Tooltip: `"X şirket hâlâ bu aşamada"`.
     - **Enabled** once all rows have a target stage.
   - On confirm: calls `POST .../deactivate` with the full migrations array.
4. On success: invalidate stages query cache, close modal, show success toast.

### Post-Deactivation Effects

- `is_active = false` stages are **hidden** from:
  - Pipeline board (no column rendered).
  - Stage `<Select>` dropdowns in company forms and filter panels.
- They remain in the DB. Reactivation is possible via `PUT /api/settings/stages/:slug` (`is_active: true`).

---

## 4. Error Handling

| Scenario | Behavior |
|---|---|
| Network error during deactivation | Modal stays open, error toast shown, no partial state |
| `targetStage` no longer valid at confirm time (race) | Server returns 422, client shows error in modal |
| FK violation on hard delete (unexpected direct DB delete) | Postgres rejects with FK error |
| Deactivating `initial` stage | Server returns 400: `"Cannot deactivate the initial stage"` |
| `companyId` not belonging to tenant | Server returns 400: validation failure |

---

## 5. Migration

File: `supabase/migrations/015_pipeline_stage_fk.sql`

Contains the pre-flight orphan check (ASSERT) and the `ALTER TABLE companies ADD CONSTRAINT fk_companies_stage ...` statement described in Section 1.

Current state: 0 orphaned stage values confirmed in production (verified 2026-03-27).

---

## Out of Scope

- Stage slug renaming via the API (not exposed, no change needed).
- Hard deletion of stages (blocked by FK after migration; not exposed in UI).
- Bulk company reassignment outside of the deactivation flow.
- Pagination on the companies list endpoint.
