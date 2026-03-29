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

Dates are sent to the API as ISO 8601 strings.

## Server API Changes

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
- **totalContacts**: Filter via company relationship — count contacts whose parent company's `created_at` falls in range
- **stageCounts** (via `get_stage_counts` RPC or inline query): Add date filter to the company query that feeds stage counts
- **conversionRate**: Calculated from filtered wonCount and lostCount

When no date params are sent, behavior is unchanged (all-time data).

### GET `/api/statistics/pipeline`

New optional query parameters: `dateFrom`, `dateTo`

Filters funnel and terminal stage counts to companies created within the date range.

### GET `/api/statistics/company-locations`

New optional query parameters: `dateFrom`, `dateTo`

Filters company locations to companies created within the date range. `missingCount` also scoped to the range.

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

## Client — Companies (Leads) Page

### UI: SegmentedControl + DatePicker

- **SegmentedControl** placed alongside existing filter dropdowns (stage, industry, location, product)
- Options: **Gün** / **Hafta** / **Ay** (Day / Week / Month)
- **Toggle behavior**: Clicking the active segment deactivates it (removes date filter, shows all companies)
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
  "customRange": "Özel Aralık"
}
"dashboard": {
  ...existing,
  "all": "Tümü"
}
```

### English (en.json)

```json
"filter": {
  ...existing,
  "day": "Day",
  "week": "Week",
  "month": "Month",
  "customRange": "Custom Range"
}
"dashboard": {
  ...existing,
  "all": "All"
}
```

## Files to Create/Modify

| File | Action |
|------|--------|
| `client/src/lib/dateUtils.ts` | Create — shared `getDateRange()` utility |
| `client/src/pages/LeadsPage.tsx` | Modify — add SegmentedControl, DatePicker, wire date params |
| `client/src/pages/DashboardPage.tsx` | Modify — add SegmentedControl, wire date params to all queries |
| `client/src/locales/en.json` | Modify — add date filter translations |
| `client/src/locales/tr.json` | Modify — add date filter translations |
| `server/src/routes/companies.ts` | Modify — accept and apply dateFrom/dateTo params |
| `server/src/routes/statistics.ts` | Modify — accept and apply dateFrom/dateTo to all endpoints |
