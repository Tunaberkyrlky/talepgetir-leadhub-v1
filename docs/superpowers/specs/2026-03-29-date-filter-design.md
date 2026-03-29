# Date-Based Filtering for Companies and Dashboard

## Overview

Use the `created_at` field from the companies table to add date-based filtering in two areas:

1. **Companies (Leads) page** — filter companies by creation date (Day/Week/Month + custom range)
2. **Dashboard page** — filter all statistics and charts by creation date (All/Day/Week/Month)

## Date Ranges

All ranges are calendar-based, not rolling:

| Period | dateFrom | dateTo |
|--------|----------|--------|
| Day (Gün) | Today 00:00 local time | Now |
| Week (Hafta) | This Monday 00:00 local time | Now |
| Month (Ay) | 1st of this month 00:00 local time | Now |
| Custom Range | Selected start date 00:00 | Selected end date 23:59:59.999 |

Dates are sent to the API as ISO 8601 strings. PostgreSQL's TIMESTAMPTZ handles timezone conversion correctly — client sends local time, Postgres compares in UTC internally.

## Database Migration

### New migration: `supabase/migrations/017_stage_counts_date_filter.sql`

**1. Update `get_stage_counts` RPC** to accept optional date parameters:

```sql
CREATE OR REPLACE FUNCTION get_stage_counts(
    p_tenant_id UUID,
    p_date_from TIMESTAMPTZ DEFAULT NULL,
    p_date_to TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE(stage TEXT, count BIGINT)
LANGUAGE sql STABLE SECURITY INVOKER
AS $$
    SELECT c.stage::TEXT, COUNT(*) AS count
    FROM companies c
    WHERE c.tenant_id = p_tenant_id
      AND (p_date_from IS NULL OR c.created_at >= p_date_from)
      AND (p_date_to IS NULL OR c.created_at <= p_date_to)
    GROUP BY c.stage;
$$;
```

Backward-compatible — existing calls without date params continue to work.

**2. Add composite index** for date-filtered queries:

```sql
CREATE INDEX idx_companies_tenant_created ON companies(tenant_id, created_at);
```

## Server API Changes

### Shared: Date Parameter Validation

A shared validation helper used by all 4 endpoints:

```typescript
function parseDateParams(dateFrom?: string, dateTo?: string): { dateFrom?: string; dateTo?: string } | null
```

- Parses with `new Date()`, returns 400 if invalid
- Returns 400 if `dateFrom > dateTo`
- Returns parsed ISO strings or undefined if not provided

### Shared: Cache Key Update

The statistics endpoints cache results by `tenantId`. Cache keys must include date params to prevent stale cross-filter results:

- Key format: `${tenantId}:${dateFrom || ''}:${dateTo || ''}`

### GET `/api/companies`

New optional query parameters:

- `dateFrom` (string, ISO 8601) — filter `created_at >= dateFrom`
- `dateTo` (string, ISO 8601) — filter `created_at <= dateTo`

Added to the existing Supabase query chain:

```
if (dateFrom) query = query.gte('created_at', dateFrom)
if (dateTo) query = query.lte('created_at', dateTo)
```

Works alongside existing filters (search, stages, industries, locations, products) and pagination.

### GET `/api/statistics/overview`

New optional query parameters: `dateFrom`, `dateTo`

Affected queries:
- **totalCompanies**: `.gte('created_at', dateFrom).lte('created_at', dateTo)` on companies count
- **totalContacts**: Sum `contact_count` from the date-filtered companies query (avoids cross-table join; leverages existing `contact_count` column maintained by triggers)
- **stageCounts**: Call updated `get_stage_counts` RPC with `p_date_from` and `p_date_to` parameters
- **conversionRate**: Calculated from filtered wonCount and lostCount

When no date params are sent, behavior is unchanged (all-time data).

### GET `/api/statistics/pipeline`

New optional query parameters: `dateFrom`, `dateTo`

Filters funnel and terminal stage counts to companies created within the date range. Uses the same updated `get_stage_counts` RPC.

### GET `/api/statistics/company-locations`

New optional query parameters: `dateFrom`, `dateTo`

Date filters applied in the Supabase query chain before `.limit(2000)`. `missingCount` also scoped to the range.

## Client — Shared Utility

### New file: `client/src/lib/dateUtils.ts`

```typescript
type DatePeriod = 'day' | 'week' | 'month';

function getDateRange(period: DatePeriod): { dateFrom: string; dateTo: string }
```

- `day`: Today 00:00 → now
- `week`: This Monday 00:00 → now
- `month`: 1st of month 00:00 → now
- Returns ISO strings
- Used by both LeadsPage and DashboardPage

For custom date ranges (LeadsPage only), `dateTo` is set to end-of-day (23:59:59.999) of the selected end date to include the full day.

## Client — Companies (Leads) Page

### UI: SegmentedControl + DatePicker

- **SegmentedControl** placed alongside existing filter dropdowns (stage, industry, location, product)
- Options: **Gün** / **Hafta** / **Ay** (Day / Week / Month)
- **Toggle behavior**: Clicking the active segment deactivates it (removes date filter, shows all companies). Requires custom `onChange` handler — Mantine's `SegmentedControl` does not natively support deselection. Implementation: compare new value to current value; if equal, set state to `null`.
- Value can be `null` (no date filter active)

- **DatePicker** (Mantine `DatePickerInput` in range mode): Small calendar icon/button next to SegmentedControl
- When a custom range is selected, SegmentedControl deactivates
- When a SegmentedControl option is selected, DatePicker clears
- The two are mutually exclusive

### State & API Integration

- New state: `datePeriod: DatePeriod | null` and `customDateRange: [Date | null, Date | null]`
- `dateFrom` / `dateTo` computed from either `datePeriod` (via `getDateRange()`) or `customDateRange`
- Added to the existing `useQuery` key: `['companies', page, search, ..., dateFrom, dateTo]`
- Changing date filter resets page to 1 (consistent with other filters)

## Client — Dashboard Page

### UI: SegmentedControl

- Placed near the dashboard header/title area
- Options: **Tümü** / **Ay** / **Hafta** / **Gün** (All / Month / Week / Day)
- Default: **Tümü** (no date filter, all-time data — preserves current behavior)
- No DatePicker on dashboard (not needed)

### State & API Integration

- New state: `datePeriod: 'day' | 'week' | 'month' | null` (null = Tümü)
- `dateFrom` / `dateTo` computed via `getDateRange()` when period is not null
- All three query hooks receive date params:
  - `useQuery(['statistics', 'overview', dateFrom, dateTo])`
  - `useQuery(['statistics', 'pipeline', dateFrom, dateTo])`
  - `useQuery(['statistics', 'company-locations', dateFrom, dateTo])`
- When "Tümü" is selected, no date params are sent

### Affected Components

- Stat cards: Total Companies, Total Contacts, Active Deals, Won Deals, Conversion Rate
- Stage Distribution chart
- Pipeline Funnel chart (Pro)
- Globe Map (Pro)

## Translations

### Turkish (tr.json)

```json
"filter": {
  ...existing,
  "day": "Gün",
  "week": "Hafta",
  "month": "Ay",
  "all": "Tümü",
  "customRange": "Özel Aralık"
}
```

### English (en.json)

```json
"filter": {
  ...existing,
  "day": "Day",
  "week": "Week",
  "month": "Month",
  "all": "All",
  "customRange": "Custom Range"
}
```

Note: "All" / "Tümü" placed under `filter` namespace (not `dashboard`) for reusability.

## Files to Create/Modify

| File | Action |
|------|--------|
| `supabase/migrations/017_stage_counts_date_filter.sql` | Create — update `get_stage_counts` RPC with date params + add composite index |
| `client/src/lib/dateUtils.ts` | Create — shared `getDateRange()` utility |
| `client/src/pages/LeadsPage.tsx` | Modify — add SegmentedControl, DatePicker, wire date params |
| `client/src/pages/DashboardPage.tsx` | Modify — add SegmentedControl, wire date params to all queries |
| `client/src/locales/en.json` | Modify — add date filter translations |
| `client/src/locales/tr.json` | Modify — add date filter translations |
| `server/src/routes/companies.ts` | Modify — accept and apply dateFrom/dateTo params + validation |
| `server/src/routes/statistics.ts` | Modify — accept and apply dateFrom/dateTo to all endpoints + update cache keys + pass date params to RPC |
