# Activities Page Enhancement Design

**Date:** 2026-03-29
**Status:** Draft

## Problem

The Activities page (`/activities`) currently has minimal filtering (type + date range) and no grouping. Both ops teams (daily tracking) and management (reporting) need richer tools to navigate and analyze activity data efficiently. The UI must remain clean and uncluttered.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Grouping | Switchable toggle (Flat / Date / Company / Type) | Serves both ops and management use cases |
| Date navigation | Segmented control (Day/Week/Month/Custom) + arrow nav | Compact, allows quick period switching and browsing |
| Company/contact filtering | Search bar instead of separate dropdowns | Keeps UI clean — user preference for simplicity |
| Visibility filter | Select dropdown (All/Internal/Client) | Useful for ops_agent and superadmin roles |
| Created-by filter | Select dropdown | Enables "who did what" tracking |
| Stats cards | Type-based counts for selected period | Management reporting at a glance |

## Page Layout

```
┌──────────────────────────────────────────────────────┐
│  Stats Cards: [Toplantı: N] [Not: N] [Takip: N] [Toplam] │
├──────────────────────────────────────────────────────┤
│  Row 1: [Gün|Hafta|Ay|Özel] ‹ 23-29 Mar ›   🔍 Search │
│  Row 2: Tip: [Hepsi|Not|Toplantı|Takip] [Visibility▾] [User▾] │
├──────────────────────────────────────────────────────┤
│  Gruplama: [Düz Liste | Güne Göre | Şirkete Göre | Tipe Göre] │
├──────────────────────────────────────────────────────┤
│  Activity List (grouped or flat)                      │
│  ...                                                  │
│  [Load More]                                          │
└──────────────────────────────────────────────────────┘
```

## Components

### 1. Stats Cards

Four `SimpleGrid` cards at the top, updating reactively with filters/date:

| Card | Color | Value |
|------|-------|-------|
| Toplantı (Meeting) | violet | Count of `meeting` type |
| Not (Note) | blue | Count of `not` type |
| Takip (Follow-up) | orange | Count of `follow_up` type |
| Toplam (Total) | gray | Sum of all activities (including `sonlandirma_raporu` and `status_change`) |

The cards show only the 3 user-created activity types individually. `sonlandirma_raporu` and `status_change` are system-generated types — they are intentionally excluded from individual cards but included in the total count.

Data source: new `GET /api/activities/stats` endpoint. Cards show skeleton loaders while the stats query is loading.

### 2. Date Navigation

**Segmented control** with 4 options: `Gün` / `Hafta` / `Ay` / `Özel`

Behavior per mode:
- **Gün:** Arrow buttons shift by 1 day. Shows: "29 Mart 2026"
- **Hafta:** Arrow buttons shift by 1 week. Shows: "23 — 29 Mart 2026"
- **Ay:** Arrow buttons shift by 1 month. Shows: "Mart 2026"
- **Özel:** Reveals DatePickerInput (from/to), arrows hidden

Constraints:
- "Next" button is disabled when the period includes today (cannot navigate to future).
- Default on page load: `Hafta` mode, current week.
- A small "Bugün" reset button appears next to the arrows when navigated away from the current period, allowing quick jump back.

State: `periodType` (`day` | `week` | `month` | `custom`) and `periodAnchor` (Date). From these, `date_from` and `date_to` are computed for the API call. Date boundaries are computed in the user's local timezone and sent as ISO date strings, consistent with existing patterns.

### 3. Filters

All filters sit in the second row, inline with the type segmented control.

**Type filter** (existing) — `SegmentedControl`: Hepsi / Not / Toplantı / Takip. Only shows the 3 user-created types; `sonlandirma_raporu` and `status_change` are system-generated and intentionally excluded from the filter UI (but still displayed in the list when they exist).

**Visibility filter** — `Select` dropdown:
- Options: Hepsi (all) / Internal / Client
- Only rendered for users with internal roles (`isInternal(user.role)`)
- Default: Hepsi
- Server-side guard: the API ignores `visibility=internal` for non-internal roles to prevent unauthorized access.

**Created-by filter** — `Select` dropdown:
- Options: Hepsi / list of tenant members
- Data source: new `GET /api/activities/users` endpoint (see API Changes)
- Searchable, clearable
- Default: Hepsi

**Search** — `TextInput` with search icon:
- Searches across: `summary` and `detail` fields only (activity's own columns)
- Debounced at 300ms using `useDebouncedValue` from `@mantine/hooks` (destructured: `const [debouncedSearch] = useDebouncedValue(search, 300)`)
- Sent as `search` query param to API
- Note: company name search is not included server-side to avoid cross-table ILIKE complexity with Supabase PostgREST. Users can find company-specific activities via the "Şirkete Göre" grouping or by visiting the company detail page.

### 4. Grouping

`SegmentedControl` below filters with 4 options:

| Mode | Label | Behavior |
|------|-------|----------|
| `none` | Düz Liste | Current flat chronological list |
| `date` | Güne Göre | Group by `occurred_at` date, headers like "Bugün", "Dün", "27 Mart 2026" |
| `company` | Şirkete Göre | Group by `company_name`, header shows company name + count badge |
| `type` | Tipe Göre | Group by `type`, header shows type icon + name + count badge |

Grouping is **client-side only** — the API returns a flat list, the frontend groups it in a `useMemo`. This keeps the API simple and avoids complex SQL.

**Pagination with grouping:** When a non-flat grouping is active, the page size increases to 100 (from the default 20) to reduce fragmented groups. The "Load More" button remains available if more data exists. This is a pragmatic trade-off — perfect grouping would require loading all data, but that has performance implications for large datasets.

Each group renders as:
```
[Group Header — bold, with count badge]
  [Activity Card]
  [Activity Card]
  [Divider]
[Group Header]
  ...
```

### 5. Activity Cards

Existing card design is preserved. No changes to individual activity card rendering.

## API Changes

### Modified: `GET /api/activities/all`

New query parameters:

| Param | Type | Description |
|-------|------|-------------|
| `search` | string | ILIKE search on `summary` and `detail` columns |
| `visibility` | `internal` \| `client` | Filter by visibility field. Server ignores `internal` value for non-internal roles. |
| `created_by` | UUID | Filter by `created_by` user ID |

Server-side validation: `visibility` is checked against `['internal', 'client']` enum; `created_by` is validated as UUID format. Invalid values are ignored (treated as unfiltered).

Existing params unchanged: `type`, `date_from`, `date_to`, `page`, `limit`.

Search implementation (Supabase JS):
```typescript
if (search) {
  query = query.or(`summary.ilike.%${search}%,detail.ilike.%${search}%`);
}
```

### New: `GET /api/activities/stats`

Returns aggregated counts for the selected filters/date range.

Query parameters: same as `/activities/all` (except `page`, `limit`).

Response:
```json
{
  "meeting": 12,
  "not": 8,
  "follow_up": 5,
  "sonlandirma_raporu": 2,
  "status_change": 1,
  "total": 28
}
```

Implementation: uses Supabase RPC or a raw query — `SELECT type, COUNT(*) FROM activities WHERE ... GROUP BY type`. Applies the same tenant scoping and filters as `/all`.

### New: `GET /api/activities/users`

Returns a lightweight list of users who have created activities in the current tenant.

Auth: requires authenticated user with valid tenant membership (same as other protected routes).

Response:
```json
[
  { "id": "uuid-1", "email": "user@example.com" },
  { "id": "uuid-2", "email": "other@example.com" }
]
```

Implementation: `SELECT DISTINCT created_by FROM activities WHERE tenant_id = $1`, then join with `auth.users` to get emails. This avoids exposing the full membership/admin endpoint and only returns users who actually have activities.

## State Management

All filter/grouping state lives in `ActivitiesPage` component state (no context needed):

```typescript
// Date navigation
const [periodType, setPeriodType] = useState<'day' | 'week' | 'month' | 'custom'>('week');
const [periodAnchor, setPeriodAnchor] = useState(new Date());
const [customRange, setCustomRange] = useState<[Date | null, Date | null]>([null, null]);

// Filters
const [typeFilter, setTypeFilter] = useState('');
const [visibilityFilter, setVisibilityFilter] = useState('');
const [createdByFilter, setCreatedByFilter] = useState('');
const [search, setSearch] = useState('');
const [debouncedSearch] = useDebouncedValue(search, 300);

// Grouping
const [groupBy, setGroupBy] = useState<'none' | 'date' | 'company' | 'type'>('none');

// Pagination
const [page, setPage] = useState(1);
```

Date range is computed from `periodType` + `periodAnchor`:
- `day`: anchor day start → end
- `week`: Monday of anchor week → Sunday
- `month`: 1st of anchor month → last day
- `custom`: `customRange[0]` → `customRange[1]`

When any filter/date changes, `page` resets to 1.

## Translations

New keys added to `client/src/locales/tr.json` and `client/src/locales/en.json` respectively:

**Turkish (`tr.json`):**
```json
{
  "activities.groupBy": "Gruplama",
  "activities.groupByNone": "Düz Liste",
  "activities.groupByDate": "Güne Göre",
  "activities.groupByCompany": "Şirkete Göre",
  "activities.groupByType": "Tipe Göre",
  "activities.periodDay": "Gün",
  "activities.periodWeek": "Hafta",
  "activities.periodMonth": "Ay",
  "activities.periodCustom": "Özel",
  "activities.search": "Ara...",
  "activities.allVisibility": "Tümü",
  "activities.allUsers": "Tüm Kullanıcılar",
  "activities.today": "Bugün",
  "activities.yesterday": "Dün",
  "activities.stats.total": "Toplam"
}
```

**English (`en.json`):**
```json
{
  "activities.groupBy": "Group By",
  "activities.groupByNone": "Flat List",
  "activities.groupByDate": "By Date",
  "activities.groupByCompany": "By Company",
  "activities.groupByType": "By Type",
  "activities.periodDay": "Day",
  "activities.periodWeek": "Week",
  "activities.periodMonth": "Month",
  "activities.periodCustom": "Custom",
  "activities.search": "Search...",
  "activities.allVisibility": "All",
  "activities.allUsers": "All Users",
  "activities.today": "Today",
  "activities.yesterday": "Yesterday",
  "activities.stats.total": "Total"
}
```

## Files to Modify

| File | Changes |
|------|---------|
| `client/src/pages/ActivitiesPage.tsx` | Major rewrite — add all new UI controls, grouping logic, stats query |
| `server/src/routes/activities.ts` | Add `search`, `visibility`, `created_by` params to `/all`; add `/stats` and `/users` endpoints |
| `client/src/locales/tr.json` | Add new translation keys |
| `client/src/locales/en.json` | Add new translation keys |

No new files needed. No changes to `ActivityTimeline.tsx`, `ActivityForm.tsx`, or database schema.
