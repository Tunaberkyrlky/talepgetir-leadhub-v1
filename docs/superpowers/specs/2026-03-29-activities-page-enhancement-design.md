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
| Toplam (Total) | gray | Sum of all activities |

Data source: new `GET /api/activities/stats` endpoint.

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

State: `periodType` (`day` | `week` | `month` | `custom`) and `periodAnchor` (Date). From these, `date_from` and `date_to` are computed for the API call.

### 3. Filters

All filters sit in the second row, inline with the type segmented control.

**Type filter** (existing) — `SegmentedControl`: Hepsi / Not / Toplantı / Takip

**Visibility filter** — `Select` dropdown:
- Options: Hepsi (all) / Internal / Client
- Only rendered for users with internal roles (`isInternal(user.role)`)
- Default: Hepsi

**Created-by filter** — `Select` dropdown:
- Options: Hepsi / list of tenant members
- Data source: existing memberships/users endpoint or a lightweight users list
- Searchable, clearable
- Default: Hepsi

**Search** — `TextInput` with search icon:
- Searches across: `summary`, `detail`, `company_name`
- Debounced at 300ms
- Sent as `search` query param to API

### 4. Grouping

`SegmentedControl` below filters with 4 options:

| Mode | Label | Behavior |
|------|-------|----------|
| `none` | Düz Liste | Current flat chronological list |
| `date` | Güne Göre | Group by `occurred_at` date, headers like "Bugün", "Dün", "27 Mart 2026" |
| `company` | Şirkete Göre | Group by `company_name`, header shows company name + count badge |
| `type` | Tipe Göre | Group by `type`, header shows type icon + name + count badge |

Grouping is **client-side only** — the API returns a flat list, the frontend groups it in a `useMemo`. This keeps the API simple and avoids complex SQL.

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
| `search` | string | ILIKE search on `summary`, `detail`, and joined `companies.name` |
| `visibility` | `internal` \| `client` | Filter by visibility field |
| `created_by` | UUID | Filter by `created_by` user ID |

Existing params unchanged: `type`, `date_from`, `date_to`, `page`, `limit`.

Search implementation:
```sql
AND (
  a.summary ILIKE '%search%'
  OR a.detail ILIKE '%search%'
  OR c.name ILIKE '%search%'
)
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

Implementation: `SELECT type, COUNT(*) FROM activities WHERE ... GROUP BY type`

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
const debouncedSearch = useDebouncedValue(search, 300);

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

New keys needed in `tr.json` and `en.json`:

```json
{
  "activities.groupBy": "Gruplama / Group By",
  "activities.groupByNone": "Düz Liste / Flat List",
  "activities.groupByDate": "Güne Göre / By Date",
  "activities.groupByCompany": "Şirkete Göre / By Company",
  "activities.groupByType": "Tipe Göre / By Type",
  "activities.periodDay": "Gün / Day",
  "activities.periodWeek": "Hafta / Week",
  "activities.periodMonth": "Ay / Month",
  "activities.periodCustom": "Özel / Custom",
  "activities.search": "Ara... / Search...",
  "activities.allVisibility": "Tümü / All",
  "activities.allUsers": "Tüm Kullanıcılar / All Users",
  "activities.today": "Bugün / Today",
  "activities.yesterday": "Dün / Yesterday",
  "activities.stats.total": "Toplam / Total"
}
```

## Files to Modify

| File | Changes |
|------|---------|
| `client/src/pages/ActivitiesPage.tsx` | Major rewrite — add all new UI controls, grouping logic, stats query |
| `server/src/routes/activities.ts` | Add `search`, `visibility`, `created_by` params to `/all`; add `/stats` endpoint |
| `client/src/i18n/locales/tr.json` | Add new translation keys |
| `client/src/i18n/locales/en.json` | Add new translation keys |

No new files needed. No changes to `ActivityTimeline.tsx`, `ActivityForm.tsx`, or database schema.
