# Date-Based Filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `created_at`-based date filtering to the Companies page (Day/Week/Month + custom range) and Dashboard page (All/Day/Week/Month), affecting all statistics, charts, and maps.

**Architecture:** Server-side filtering via `dateFrom`/`dateTo` query params on 4 API endpoints. Client computes calendar-based date ranges (today, this week, this month) and sends ISO strings. A DB migration updates the `get_stage_counts` RPC to accept optional date params and adds a composite index.

**Tech Stack:** React, Mantine UI (`SegmentedControl`, `DatePickerInput` from `@mantine/dates`), dayjs, Express, Supabase (PostgreSQL RPC)

**Spec:** `docs/superpowers/specs/2026-03-29-date-filter-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `supabase/migrations/017_date_filter_support.sql` | Create | Update `get_stage_counts` RPC + composite index |
| `client/src/lib/dateUtils.ts` | Create | Shared `getDateRange()` utility |
| `client/src/locales/en.json` | Modify | Add date filter translation keys |
| `client/src/locales/tr.json` | Modify | Add date filter translation keys |
| `server/src/routes/companies.ts` | Modify | Accept/apply `dateFrom`/`dateTo` params |
| `server/src/routes/statistics.ts` | Modify | Accept/apply date params on all 3 endpoints + fix cache key/invalidation |
| `client/src/pages/LeadsPage.tsx` | Modify | Add SegmentedControl + DatePicker, wire date params |
| `client/src/pages/DashboardPage.tsx` | Modify | Add SegmentedControl, wire date params to all queries |

---

## Task 1: Database Migration

**Files:**
- Create: `supabase/migrations/017_date_filter_support.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- Update get_stage_counts RPC to accept optional date params
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

-- Composite index for date-filtered queries
CREATE INDEX IF NOT EXISTS idx_companies_tenant_created
    ON companies(tenant_id, created_at);
```

- [ ] **Step 2: Apply migration to Supabase**

Run via Supabase dashboard SQL editor or CLI. Verify the function signature changed:
```sql
SELECT proname, pg_get_function_arguments(oid)
FROM pg_proc WHERE proname = 'get_stage_counts';
```
Expected: `p_tenant_id uuid, p_date_from timestamp with time zone DEFAULT NULL, p_date_to timestamp with time zone DEFAULT NULL`

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/017_date_filter_support.sql
git commit -m "feat: add date filter support to get_stage_counts RPC + index"
```

---

## Task 2: Shared Date Utility

**Files:**
- Create: `client/src/lib/dateUtils.ts`

- [ ] **Step 1: Create the utility file**

```typescript
import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek';

dayjs.extend(isoWeek);

export type DatePeriod = 'day' | 'week' | 'month';

export function getDateRange(period: DatePeriod): { dateFrom: string; dateTo: string } {
    const now = dayjs();
    let start: dayjs.Dayjs;

    switch (period) {
        case 'day':
            start = now.startOf('day');
            break;
        case 'week':
            start = now.startOf('isoWeek'); // Monday-start week
            break;
        case 'month':
            start = now.startOf('month');
            break;
    }

    return {
        dateFrom: start.toISOString(),
        dateTo: now.toISOString(),
    };
}

export function getCustomDateRange(from: Date, to: Date): { dateFrom: string; dateTo: string } {
    return {
        dateFrom: dayjs(from).startOf('day').toISOString(),
        dateTo: dayjs(to).endOf('day').toISOString(),
    };
}
```

- [ ] **Step 2: Commit**

```bash
git add client/src/lib/dateUtils.ts
git commit -m "feat: add shared date range utility"
```

---

## Task 3: Translation Keys

**Files:**
- Modify: `client/src/locales/en.json` (lines 217-226, filter section)
- Modify: `client/src/locales/tr.json` (lines 217-226, filter section)

- [ ] **Step 1: Add English translations**

In `en.json`, add to the `"filter"` object (after the existing `"tryDifferent"` key):

```json
"day": "Day",
"week": "Week",
"month": "Month",
"all": "All",
"customRange": "Custom Range"
```

- [ ] **Step 2: Add Turkish translations**

In `tr.json`, add to the `"filter"` object (after the existing `"tryDifferent"` key):

```json
"day": "Gün",
"week": "Hafta",
"month": "Ay",
"all": "Tümü",
"customRange": "Özel Aralık"
```

- [ ] **Step 3: Commit**

```bash
git add client/src/locales/en.json client/src/locales/tr.json
git commit -m "feat: add date filter translation keys (en/tr)"
```

---

## Task 4: Server — Companies Endpoint Date Filtering

**Files:**
- Modify: `server/src/routes/companies.ts` (lines 60-121)

- [ ] **Step 1: Parse date params alongside existing query params**

After line 73 (after `products` parsing), add:

```typescript
const dateFrom = req.query.dateFrom as string | undefined;
const dateTo = req.query.dateTo as string | undefined;

// Validate date params
if (dateFrom && isNaN(Date.parse(dateFrom))) {
    return res.status(400).json({ error: 'Invalid dateFrom parameter' });
}
if (dateTo && isNaN(Date.parse(dateTo))) {
    return res.status(400).json({ error: 'Invalid dateTo parameter' });
}
if (dateFrom && dateTo && new Date(dateFrom) > new Date(dateTo)) {
    return res.status(400).json({ error: 'dateFrom must be before dateTo' });
}
```

- [ ] **Step 2: Apply date filters to both count and data queries**

After the existing filter chain (after products filter around line 121), add date filters to both `countQuery` and `dataQuery`:

```typescript
if (dateFrom) {
    countQuery = countQuery.gte('created_at', dateFrom);
    dataQuery = dataQuery.gte('created_at', dateFrom);
}
if (dateTo) {
    countQuery = countQuery.lte('created_at', dateTo);
    dataQuery = dataQuery.lte('created_at', dateTo);
}
```

This follows the exact same pattern used by stages/industries/locations/products filters.

- [ ] **Step 3: Verify the dev server starts without errors**

Run: `npm run dev:server`
Expected: Server starts on port 3001 without errors.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/companies.ts
git commit -m "feat: add dateFrom/dateTo filtering to companies endpoint"
```

---

## Task 5: Server — Statistics Endpoints Date Filtering

**Files:**
- Modify: `server/src/routes/statistics.ts` (lines 11-194)

This is the largest server change. It touches 3 endpoints + cache logic.

- [ ] **Step 1: Update cache key format and invalidation functions**

Replace the `invalidateOverviewCache` function (line 20-22) with:

```typescript
export function invalidateOverviewCache(tenantId: string) {
    for (const key of overviewCache.keys()) {
        if (key.startsWith(tenantId)) overviewCache.delete(key);
    }
}
```

Replace the `invalidatePipelineStatsCache` function (line 96-98) with:

```typescript
export function invalidatePipelineStatsCache(tenantId: string) {
    for (const key of pipelineStatsCache.keys()) {
        if (key.startsWith(tenantId)) pipelineStatsCache.delete(key);
    }
}
```

- [ ] **Step 2: Add date param parsing helper at top of file**

After the cache declarations (after line 22), add:

```typescript
function parseDateFilters(req: Request, res: Response): { dateFrom?: string; dateTo?: string } | null {
    const dateFrom = req.query.dateFrom as string | undefined;
    const dateTo = req.query.dateTo as string | undefined;

    if (dateFrom && isNaN(Date.parse(dateFrom))) {
        res.status(400).json({ error: 'Invalid dateFrom parameter' });
        return null;
    }
    if (dateTo && isNaN(Date.parse(dateTo))) {
        res.status(400).json({ error: 'Invalid dateTo parameter' });
        return null;
    }
    if (dateFrom && dateTo && new Date(dateFrom) > new Date(dateTo)) {
        res.status(400).json({ error: 'dateFrom must be before dateTo' });
        return null;
    }

    return { dateFrom, dateTo };
}

function buildCacheKey(tenantId: string, dateFrom?: string, dateTo?: string): string {
    return `${tenantId}:${dateFrom || ''}:${dateTo || ''}`;
}
```

- [ ] **Step 3: Update GET /overview endpoint**

In the overview handler (starting ~line 25):

a) Parse date params and use composite cache key:
```typescript
const dateFilters = parseDateFilters(req, res);
if (!dateFilters) return; // 400 already sent
const { dateFrom, dateTo } = dateFilters;
const cacheKey = buildCacheKey(tenantId, dateFrom, dateTo);
const cached = overviewCache.get(cacheKey);
if (cached && Date.now() - cached.ts < OVERVIEW_TTL) {
    return res.json(cached.data);
}
```

b) Update the 4 parallel queries (lines 37-49):

**Companies count** — add date filters:
```typescript
let companiesQuery = supabaseAdmin
    .from('companies')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', tenantId);
if (dateFrom) companiesQuery = companiesQuery.gte('created_at', dateFrom);
if (dateTo) companiesQuery = companiesQuery.lte('created_at', dateTo);
```

**Contacts count** — branch based on date filter presence:
```typescript
let totalContacts: number;
if (dateFrom || dateTo) {
    // Sum contact_count from date-filtered companies
    let contactQuery = supabaseAdmin
        .from('companies')
        .select('contact_count')
        .eq('tenant_id', tenantId);
    if (dateFrom) contactQuery = contactQuery.gte('created_at', dateFrom);
    if (dateTo) contactQuery = contactQuery.lte('created_at', dateTo);
    const { data: contactData } = await contactQuery;
    totalContacts = (contactData || []).reduce((sum, c) => sum + (c.contact_count || 0), 0);
} else {
    // Existing efficient head count on contacts table
    const { count } = await supabaseAdmin
        .from('contacts')
        .select('*', { count: 'exact', head: true })
        .eq('tenant_id', tenantId);
    totalContacts = count ?? 0;
}
```

**Stage counts** — pass date params to RPC:
```typescript
supabaseAdmin.rpc('get_stage_counts', {
    p_tenant_id: tenantId,
    p_date_from: dateFrom || null,
    p_date_to: dateTo || null,
})
```

c) Update cache storage to use `cacheKey`:
```typescript
overviewCache.set(cacheKey, { data: result, ts: Date.now() });
```

- [ ] **Step 4: Update GET /pipeline endpoint**

In the pipeline handler (starting ~line 101):

a) Parse date params and use composite cache key (same pattern as overview — `parseDateFilters(req, res)` with null check).

b) Pass date params to RPC call (line ~113):
```typescript
supabaseAdmin.rpc('get_stage_counts', {
    p_tenant_id: tenantId,
    p_date_from: dateFrom || null,
    p_date_to: dateTo || null,
})
```

c) Update cache storage to use `cacheKey`.

- [ ] **Step 5: Update GET /company-locations endpoint**

In the company-locations handler (starting ~line 150):

a) Parse date params: `const dateFilters = parseDateFilters(req, res); if (!dateFilters) return;`

b) Modify the existing `Promise.all` queries to include date filters. The existing code has two queries inline in a `Promise.all`. Do NOT change the query structure — just chain `.gte`/`.lte` onto each existing query before execution.

For the **locations query** (lines 161-168) — add date filters. Note: this query does NOT have `.in('stage', geocodableStages)` — preserve the existing filters exactly, only append date filters:
```typescript
// Inside the existing Promise.all, chain onto the locations query:
// ... existing .not('latitude', 'is', null).not('longitude', 'is', null).limit(2000)
// Add before .limit() or after existing chain:
if (dateFrom) locationsQuery = locationsQuery.gte('created_at', dateFrom);
if (dateTo) locationsQuery = locationsQuery.lte('created_at', dateTo);
```

For the **missing-count query** (lines 169-177) — this one has `.in('stage', geocodableStages)` and a `geocodableStages.length > 0` guard. Preserve both, just add date filters:
```typescript
// Inside the existing conditional: geocodableStages.length > 0 ? ...
// Chain onto the missing-count query:
if (dateFrom) missingQuery = missingQuery.gte('created_at', dateFrom);
if (dateTo) missingQuery = missingQuery.lte('created_at', dateTo);
```

To make the queries chainable, extract them into `let` variables before `Promise.all`, apply date filters conditionally, then pass them to `Promise.all`. Preserve the `geocodableStages.length > 0` ternary guard on the missing-count query.

- [ ] **Step 6: Verify the dev server starts without errors**

Run: `npm run dev:server`
Expected: Server starts on port 3001 without errors.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/statistics.ts
git commit -m "feat: add dateFrom/dateTo filtering to all statistics endpoints"
```

---

## Task 6: Client — LeadsPage Date Filter UI

**Files:**
- Modify: `client/src/pages/LeadsPage.tsx`

- [ ] **Step 1: Add imports**

Add `useMemo` to the existing React import (line 1 currently has `useState, useEffect, useCallback, useRef`):
```typescript
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
```

Add at top of file:
```typescript
import { SegmentedControl } from '@mantine/core'; // likely already imported
import { DatePickerInput } from '@mantine/dates';
import { IconCalendar } from '@tabler/icons-react';
import { type DatePeriod, getDateRange, getCustomDateRange } from '../lib/dateUtils';
```

- [ ] **Step 2: Add date filter state**

After the existing filter states (~line 256), add:

```typescript
const [datePeriod, setDatePeriod] = useState<DatePeriod | null>(null);
const [customDateRange, setCustomDateRange] = useState<[Date | null, Date | null]>([null, null]);
```

- [ ] **Step 3: Add computed date params**

After the state declarations, add:

```typescript
const dateParams = useMemo(() => {
    if (datePeriod) return getDateRange(datePeriod);
    if (customDateRange[0] && customDateRange[1]) {
        return getCustomDateRange(customDateRange[0], customDateRange[1]);
    }
    return null;
}, [datePeriod, customDateRange]);
```

- [ ] **Step 4: Wire date params into buildQueryParams**

In the `buildQueryParams` callback (~line 281), add before `return params.toString()`:

```typescript
if (dateParams?.dateFrom) params.set('dateFrom', dateParams.dateFrom);
if (dateParams?.dateTo) params.set('dateTo', dateParams.dateTo);
```

Update the `useCallback` dependency array to include `dateParams`.

- [ ] **Step 5: Add dateParams to useQuery key**

In the `useQuery` call (~line 297), add `dateParams` to the `queryKey` array:

```typescript
queryKey: ['companies', page, debouncedSearch, selectedStages, selectedIndustries, selectedLocations, selectedProducts, sortBy, sortOrder, dateParams],
```

- [ ] **Step 6: Reset page on date filter change**

Add `dateParams` to the existing `useEffect` that resets page (~line 356) or add a new one:

```typescript
useEffect(() => {
    setPage(1);
}, [dateParams]);
```

- [ ] **Step 7: Add toggle handler**

Note: Mantine's `SegmentedControl` does NOT fire `onChange` when clicking the already-active segment, so toggle-off is not possible with it. Use a `Button.Group` with toggle buttons instead:

```typescript
const handleDatePeriodToggle = (value: DatePeriod) => {
    if (value === datePeriod) {
        setDatePeriod(null); // toggle off
    } else {
        setDatePeriod(value);
        setCustomDateRange([null, null]); // clear custom range
    }
};

const handleCustomDateChange = (value: [Date | null, Date | null]) => {
    setCustomDateRange(value);
    if (value[0] && value[1]) {
        setDatePeriod(null); // clear period when custom range selected
    }
};
```

- [ ] **Step 8: Add UI components in the filter area**

In the filter area (~line 937, after existing MultiSelect components), add:

```tsx
<Button.Group>
    {(['day', 'week', 'month'] as DatePeriod[]).map((period) => (
        <Button
            key={period}
            variant={datePeriod === period ? 'filled' : 'default'}
            size="sm"
            onClick={() => handleDatePeriodToggle(period)}
        >
            {t(`filter.${period}`)}
        </Button>
    ))}
</Button.Group>

<DatePickerInput
    type="range"
    placeholder={t('filter.customRange')}
    value={customDateRange}
    onChange={handleCustomDateChange}
    leftSection={<IconCalendar size={16} />}
    clearable
    size="sm"
    maxDate={new Date()}
    w={220}
/>
```

Exact placement: integrate into the existing `Group` or `Flex` container that holds the filter dropdowns.

Note: `Button` and `Button.Group` are from `@mantine/core` — ensure they're imported.

- [ ] **Step 9: Update hasActiveFilters and clearAllFilters**

The existing `hasActiveFilters` (~line 540) and `clearAllFilters` (~line 542) only check the 4 MultiSelect filters + search. Update:

In `hasActiveFilters`, add to the condition:
```typescript
|| !!datePeriod || !!(customDateRange[0] && customDateRange[1])
```

In `clearAllFilters`, add:
```typescript
setDatePeriod(null);
setCustomDateRange([null, null]);
```

This ensures the "Clear filters" button appears when only a date filter is active, and that it clears date filters too.

- [ ] **Step 10: Verify in browser**

Run: `npm run dev`
- Navigate to Leads page
- Verify SegmentedControl renders next to filters
- Click "Day" → companies should filter to today's
- Click "Day" again → filter deactivates, all companies shown
- Select a custom date range → SegmentedControl deactivates
- Select "Week" → DatePicker clears

- [ ] **Step 11: Commit**

```bash
git add client/src/pages/LeadsPage.tsx
git commit -m "feat: add date filter UI to leads page (segment + datepicker)"
```

---

## Task 7: Client — Dashboard Date Filter UI

**Files:**
- Modify: `client/src/pages/DashboardPage.tsx`

- [ ] **Step 1: Add imports**

Add `useMemo` to the existing React import if not already present, and add:

```typescript
import { SegmentedControl } from '@mantine/core'; // likely already imported
import { type DatePeriod, getDateRange } from '../lib/dateUtils';
```

- [ ] **Step 2: Add date filter state**

After existing state/query declarations (~line 60), add:

```typescript
const [datePeriod, setDatePeriod] = useState<DatePeriod | null>(null);

const dateParams = useMemo(() => {
    if (!datePeriod) return null;
    return getDateRange(datePeriod);
}, [datePeriod]);
```

- [ ] **Step 3: Update all useQuery calls to include date params**

**Overview query** (~line 63):
```typescript
const { data: overview, isLoading: overviewLoading, error: overviewError } = useQuery<OverviewData>({
    queryKey: ['statistics', 'overview', dateParams],
    queryFn: async () => {
        const params = new URLSearchParams();
        if (dateParams?.dateFrom) params.set('dateFrom', dateParams.dateFrom);
        if (dateParams?.dateTo) params.set('dateTo', dateParams.dateTo);
        const query = params.toString();
        return (await api.get(`/statistics/overview${query ? `?${query}` : ''}`)).data;
    },
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    refetchInterval: 5 * 60_000,
});
```

**Company locations query** (~line 73):
```typescript
const { data: companyLocations, isLoading: locationsLoading } = useQuery<{ data: CompanyLocation[], missingCount: number }>({
    queryKey: ['statistics', 'company-locations', dateParams],
    queryFn: async () => {
        const params = new URLSearchParams();
        if (dateParams?.dateFrom) params.set('dateFrom', dateParams.dateFrom);
        if (dateParams?.dateTo) params.set('dateTo', dateParams.dateTo);
        const query = params.toString();
        return (await api.get(`/statistics/company-locations${query ? `?${query}` : ''}`)).data;
    },
    enabled: isAdvanced,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
});
```

**Pipeline query** (~line 97):
```typescript
const { data: pipeline } = useQuery<PipelineData>({
    queryKey: ['statistics', 'pipeline', dateParams],
    queryFn: async () => {
        const params = new URLSearchParams();
        if (dateParams?.dateFrom) params.set('dateFrom', dateParams.dateFrom);
        if (dateParams?.dateTo) params.set('dateTo', dateParams.dateTo);
        const query = params.toString();
        return (await api.get(`/statistics/pipeline${query ? `?${query}` : ''}`)).data;
    },
    enabled: isAdvanced,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    refetchInterval: isAdvanced ? 5 * 60_000 : false,
});
```

- [ ] **Step 4: Add SegmentedControl to dashboard header**

Replace the header area (~lines 132-135) with:

```tsx
<Container size="xl" py="lg">
    <Group justify="space-between" align="center" mb="lg">
        <Title order={2} fw={700}>
            {t('nav.dashboard')}
        </Title>
        <SegmentedControl
            value={datePeriod || 'all'}
            onChange={(value) => setDatePeriod(value === 'all' ? null : value as DatePeriod)}
            data={[
                { label: t('filter.all'), value: 'all' },
                { label: t('filter.month'), value: 'month' },
                { label: t('filter.week'), value: 'week' },
                { label: t('filter.day'), value: 'day' },
            ]}
            size="sm"
        />
    </Group>
```

Note: Dashboard uses "All" as default (no toggle-off behavior needed, "All" = no filter).

- [ ] **Step 5: Verify in browser**

Run: `npm run dev`
- Navigate to Dashboard
- Default "Tümü" selected → all-time data (same as before)
- Switch to "Ay" → stat cards, stage distribution, funnel, globe update
- Switch to "Gün" → shows today's data only
- Switch back to "Tümü" → all-time data restored

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/DashboardPage.tsx
git commit -m "feat: add date filter to dashboard (all/month/week/day)"
```

---

## Task 8: Final Verification & Lint

- [ ] **Step 1: Run lint**

```bash
cd client && npm run lint
```

Fix any lint errors.

- [ ] **Step 2: Run build**

```bash
npm run build
```

Fix any TypeScript or build errors.

- [ ] **Step 3: Manual E2E check**

Verify both pages in browser:
- Leads page: SegmentedControl toggle on/off, DatePicker range selection, mutual exclusivity, pagination resets
- Dashboard: All/Month/Week/Day switching, all cards + charts update
- Switch language (TR↔EN) — date filter labels translate correctly

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix: lint and build fixes for date filtering"
```
