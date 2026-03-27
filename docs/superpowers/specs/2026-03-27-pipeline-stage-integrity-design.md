# Pipeline Stage Referential Integrity & Deactivation Flow

**Date:** 2026-03-27
**Status:** Approved

## Problem

`companies.stage` is a free-text field with no foreign key to `pipeline_stages`. This means:
- A stage can be deleted while companies still reference it, leaving orphaned stage values.
- Stage renames do not propagate to companies.
- No DB-level guarantee that a company's stage is valid for its tenant.

## Solution Overview

Add a composite foreign key from `companies(tenant_id, stage)` to `pipeline_stages(tenant_id, slug)`, and build a mandatory company migration flow before a stage can be deactivated.

---

## 1. Database Layer

### Composite FK

```sql
ALTER TABLE companies
  ADD CONSTRAINT fk_companies_stage
  FOREIGN KEY (tenant_id, stage)
  REFERENCES pipeline_stages(tenant_id, slug)
  ON UPDATE CASCADE
  ON DELETE RESTRICT;
```

- **ON UPDATE CASCADE**: if a stage slug is renamed, all companies update automatically.
- **ON DELETE RESTRICT**: hard deletion of a stage is blocked if any company references it. Combined with the soft-delete flow below, hard deletes should never be attempted on active stages.

### Soft Delete (existing column)

`pipeline_stages.is_active` (BOOLEAN, already present) is set to `false` to deactivate a stage. The row remains, so the FK is satisfied.

---

## 2. Server Layer

### New Endpoints

#### `GET /api/admin/pipeline-stages/:id/companies`
Returns the list of companies currently assigned to this stage.

**Response:**
```json
{
  "stage": { "id": "...", "slug": "qualified", "display_name": "Qualified" },
  "companies": [
    { "id": "...", "name": "Acme Corp" },
    ...
  ]
}
```

#### `POST /api/admin/pipeline-stages/:id/deactivate`
Atomically migrates companies and deactivates the stage.

**Request body:**
```json
{
  "migrations": [
    { "companyId": "uuid", "targetStage": "cold" },
    ...
  ]
}
```

**Behavior:**
1. Apply all explicit migrations (UPDATE companies SET stage = targetStage WHERE id = companyId AND tenant_id = ...).
2. Move any remaining companies in this stage to `cold`.
3. Set `pipeline_stages.is_active = false`.
4. All three steps run inside a single database transaction.

**Edge case:** If the stage has 0 companies, steps 1 and 2 are skipped — stage is deactivated immediately.

**Authorization:** `ops_agent` and above.

---

## 3. Client Layer

### Trigger
Admin clicks "Deactivate" on a stage in the Pipeline Settings panel.

### Flow

1. Client calls `GET /api/admin/pipeline-stages/:id/companies`.
2. **If 0 companies:** calls `POST .../deactivate` directly with `{ migrations: [] }`. No modal.
3. **If >0 companies:** opens a **Modal** containing:
   - Title: *"[Stage Name] aşamasını devre dışı bırak"*
   - Company list: each row shows company name + a stage `<Select>` dropdown (options: all active stages except the current one being deactivated).
   - **"Tümünü Cold'a Taşı"** bulk action button at the top — sets all dropdowns to `cold`.
   - **"Deactivate Et"** confirm button at the bottom:
     - **Disabled** while any company has no target stage selected. Tooltip: *"X şirket hâlâ bu aşamada"*.
     - **Enabled** once all companies have a target stage.
   - On confirm: calls `POST .../deactivate` with the full migrations array.

### Post-Deactivation

- `is_active = false` stages are hidden from:
  - Pipeline board (no column rendered).
  - Stage dropdowns in company forms and filters.
- They remain in the database for historical reference and can be reactivated.

---

## 4. Error Handling

| Scenario | Behavior |
|---|---|
| Network error during deactivation | Modal stays open, error toast shown, no partial state |
| FK violation (unexpected orphan) | Server returns 409, client shows error |
| Reactivating a stage | `PATCH /api/admin/pipeline-stages/:id` sets `is_active = true` — existing behavior |

---

## 5. Migration

A new SQL migration (`013_pipeline_stage_fk.sql`) adds the composite FK. Before adding the constraint, a data-integrity check ensures no orphaned stage values exist (currently confirmed clean — 0 orphans in production).

---

## Out of Scope

- Stage ordering / renaming UI (existing feature, unchanged).
- Hard deletion of stages (blocked by FK; not exposed in UI).
- Bulk company reassignment outside of the deactivation flow.
