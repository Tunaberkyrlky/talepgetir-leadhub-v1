# Activities Page Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enhance the Activities page with switchable grouping, segmented date navigation, additional filters (visibility, created-by, search), and stats cards.

**Architecture:** Server-side changes add 3 new query params to `/all`, plus two new endpoints (`/stats`, `/users`). Client-side rewrites `ActivitiesPage.tsx` with new controls and client-side grouping logic via `useMemo`. Existing `ActivityTimeline.tsx` and `ActivityForm.tsx` are untouched.

**Tech Stack:** React 19, Mantine UI (SegmentedControl, Select, TextInput, SimpleGrid, Skeleton), TanStack React Query, Express.js, Supabase JS client, i18next

**Spec:** `docs/superpowers/specs/2026-03-29-activities-page-enhancement-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `server/src/routes/activities.ts` | Modify | Add `search`, `visibility`, `created_by` params to `/all`; add `/stats` and `/users` endpoints |
| `client/src/pages/ActivitiesPage.tsx` | Rewrite | All new UI: stats cards, date nav, filters, grouping, activity list |
| `client/src/locales/tr.json` | Modify | Add new translation keys under `activities` section |
| `client/src/locales/en.json` | Modify | Add new translation keys under `activities` section |

---

## Task 1: Add translation keys

**Files:**
- Modify: `client/src/locales/tr.json` (inside `"activities": { ... }` block, around line 469)
- Modify: `client/src/locales/en.json` (inside `"activities": { ... }` block, around line 469)

- [ ] **Step 1: Add Turkish translation keys**

In `client/src/locales/tr.json`, find the `"activities"` object (around line 469) and add these keys alongside the existing ones:

```json
"activities": {
    "pageTitle": "Aktiviteler",
    "dateRange": "Tarih aralığı seçin",
    "contact": "Kişi",
    "selectContact": "Kişi seçin (opsiyonel)",
    "all": "Tümü",
    "addActivity": "Aktivite Ekle",
    "showActivities": "Aktiviteleri Göster",
    "types": {
        "not": "Not",
        "meeting": "Toplantı",
        "follow_up": "Takip"
    },
    "groupByNone": "Düz Liste",
    "groupByDate": "Güne Göre",
    "groupByCompany": "Şirkete Göre",
    "groupByType": "Tipe Göre",
    "periodDay": "Gün",
    "periodWeek": "Hafta",
    "periodMonth": "Ay",
    "periodCustom": "Özel",
    "search": "Ara...",
    "allVisibility": "Tümü",
    "allUsers": "Tüm Kullanıcılar",
    "today": "Bugün",
    "yesterday": "Dün",
    "statsTotal": "Toplam",
}
```

- [ ] **Step 2: Add English translation keys**

In `client/src/locales/en.json`, find the `"activities"` object and add the same new keys:

```json
"activities": {
    "pageTitle": "Activities",
    "dateRange": "Select date range",
    "contact": "Contact",
    "selectContact": "Select contact (optional)",
    "all": "All",
    "addActivity": "Add Activity",
    "showActivities": "Show Activities",
    "types": {
        "not": "Note",
        "meeting": "Meeting",
        "follow_up": "Follow-up"
    },
    "groupByNone": "Flat List",
    "groupByDate": "By Date",
    "groupByCompany": "By Company",
    "groupByType": "By Type",
    "periodDay": "Day",
    "periodWeek": "Week",
    "periodMonth": "Month",
    "periodCustom": "Custom",
    "search": "Search...",
    "allVisibility": "All",
    "allUsers": "All Users",
    "today": "Today",
    "yesterday": "Yesterday",
    "statsTotal": "Total",
}
```

- [ ] **Step 3: Verify translations load**

Run: `cd client && npm run build 2>&1 | head -20`
Expected: No translation-related build errors.

- [ ] **Step 4: Commit**

```bash
git add client/src/locales/tr.json client/src/locales/en.json
git commit -m "feat(i18n): add activities page enhancement translation keys"
```

---

## Task 2: Add `search`, `visibility`, `created_by` params to `/all` endpoint

**Files:**
- Modify: `server/src/routes/activities.ts` (the `/all` GET handler, around lines 98-168)

- [ ] **Step 1: Add new query param extraction and filtering**

In `server/src/routes/activities.ts`, find the `/all` handler. After the existing `const { type, date_from, date_to } = req.query;` line (around line 101), add extraction for the new params. Then add filter clauses after the existing `if (date_to)` block (around line 121).

Add to destructuring:
```typescript
const { type, date_from, date_to, search, visibility, created_by } = req.query;
```

Add after the `if (date_to)` line:
```typescript
// Search: ILIKE on summary and detail
if (search && typeof search === 'string' && search.trim()) {
    const term = search.trim();
    query = query.or(`summary.ilike.%${term}%,detail.ilike.%${term}%`);
}

// Visibility filter (only internal roles can filter by 'internal')
if (visibility && typeof visibility === 'string') {
    const allowed = ['internal', 'client'];
    if (allowed.includes(visibility)) {
        if (visibility === 'internal' && !isInternalRole(req.user!.role)) {
            // Non-internal roles cannot see internal activities — ignore the filter
        } else {
            query = query.eq('visibility', visibility);
        }
    }
}

// Created-by filter
if (created_by && typeof created_by === 'string') {
    // Basic UUID format check
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(created_by)) {
        query = query.eq('created_by', created_by);
    }
}
```

Note: `isInternalRole` is already imported at the top of the file.

- [ ] **Step 2: Also increase the max limit**

In the same handler, change the limit clamping (around line 103) from `Math.min(50, ...)` to `Math.min(100, ...)` to support the larger page sizes used when grouping is active:

```typescript
const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
```

- [ ] **Step 3: Verify server builds**

Run: `cd server && npx tsc --noEmit 2>&1 | head -20`
Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/activities.ts
git commit -m "feat(api): add search, visibility, created_by filters to activities/all"
```

---

## Task 3: Add `/stats` endpoint

**Files:**
- Modify: `server/src/routes/activities.ts` (add new route before the `/:id` handler, around line 170)

- [ ] **Step 1: Add the stats endpoint**

Insert this new route **before** the `/:id` GET handler (important: Express matches routes top-down, so `/stats` must come before `/:id`):

```typescript
// GET /api/activities/stats — Aggregated counts by type
router.get('/stats', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const { type, date_from, date_to, search, visibility, created_by } = req.query;

        const db = dbClient(req);
        let query = db
            .from('activities')
            .select('type')
            .eq('tenant_id', tenantId);

        if (type) {
            const VALID_TYPES = ['not', 'meeting', 'follow_up', 'sonlandirma_raporu', 'status_change'];
            if (VALID_TYPES.includes(type as string)) {
                query = query.eq('type', type as string);
            }
        }
        if (date_from) query = query.gte('occurred_at', date_from as string);
        if (date_to) query = query.lte('occurred_at', date_to as string);

        if (search && typeof search === 'string' && search.trim()) {
            const term = search.trim();
            query = query.or(`summary.ilike.%${term}%,detail.ilike.%${term}%`);
        }
        if (visibility && typeof visibility === 'string') {
            const allowed = ['internal', 'client'];
            if (allowed.includes(visibility)) {
                if (visibility === 'internal' && !isInternalRole(req.user!.role)) {
                    // skip
                } else {
                    query = query.eq('visibility', visibility);
                }
            }
        }
        if (created_by && typeof created_by === 'string') {
            const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            if (uuidRegex.test(created_by)) {
                query = query.eq('created_by', created_by);
            }
        }

        const { data, error } = await query;

        if (error) {
            log.error({ err: error }, 'Activity stats error');
            throw new AppError('Failed to fetch activity stats', 500);
        }

        // Count by type
        const counts: Record<string, number> = {};
        let total = 0;
        for (const row of data || []) {
            const t = (row as any).type as string;
            counts[t] = (counts[t] || 0) + 1;
            total++;
        }

        res.json({
            meeting: counts['meeting'] || 0,
            not: counts['not'] || 0,
            follow_up: counts['follow_up'] || 0,
            sonlandirma_raporu: counts['sonlandirma_raporu'] || 0,
            status_change: counts['status_change'] || 0,
            total,
        });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Activity stats error');
        res.status(500).json({ error: 'Failed to fetch activity stats' });
    }
});
```

Note: This fetches all matching rows and counts client-side because Supabase JS doesn't support `GROUP BY` directly. For the expected data volumes (activities per tenant per period), this is acceptable. The query only selects the `type` column to minimize data transfer.

- [ ] **Step 2: Verify server builds**

Run: `cd server && npx tsc --noEmit 2>&1 | head -20`
Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/activities.ts
git commit -m "feat(api): add GET /activities/stats endpoint"
```

---

## Task 4: Add `/users` endpoint

**Files:**
- Modify: `server/src/routes/activities.ts` (add new route after `/stats`, before `/:id`)

- [ ] **Step 1: Add the users endpoint**

Insert after the `/stats` handler:

```typescript
// GET /api/activities/users — List users who have created activities in this tenant
router.get('/users', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;

        // Get distinct created_by user IDs from activities
        const { data: activities, error } = await supabaseAdmin
            .from('activities')
            .select('created_by')
            .eq('tenant_id', tenantId)
            .not('created_by', 'is', null);

        if (error) {
            log.error({ err: error }, 'Activity users error');
            throw new AppError('Failed to fetch activity users', 500);
        }

        const uniqueIds = [...new Set((activities || []).map((a: any) => a.created_by))];

        if (uniqueIds.length === 0) {
            res.json([]);
            return;
        }

        // Resolve emails via Supabase Auth admin API
        // (memberships table does not have an email column)
        const { data: { users: authUsers }, error: authError } = await supabaseAdmin.auth.admin.listUsers();

        if (authError) {
            log.error({ err: authError }, 'Activity users auth lookup error');
            throw new AppError('Failed to fetch user details', 500);
        }

        const userMap = new Map(authUsers.map(u => [u.id, u.email]));
        const users = uniqueIds
            .filter(id => userMap.has(id))
            .map(id => ({ id, email: userMap.get(id) }));

        res.json(users);
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Activity users error');
        res.status(500).json({ error: 'Failed to fetch activity users' });
    }
});
```

- [ ] **Step 3: Verify server builds**

Run: `cd server && npx tsc --noEmit 2>&1 | head -20`
Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/activities.ts
git commit -m "feat(api): add GET /activities/users endpoint"
```

---

## Task 5: Rewrite ActivitiesPage — date navigation and state

**Files:**
- Modify: `client/src/pages/ActivitiesPage.tsx` (full rewrite)

This is the largest task. We'll build the page incrementally. Start by replacing the existing page with the new state management and date navigation UI.

- [ ] **Step 1: Replace ActivitiesPage with new imports, state, and date helpers**

Rewrite `client/src/pages/ActivitiesPage.tsx` with the full new implementation. The file has these sections:

**Imports:**
```typescript
import { useState, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
    Container,
    Title,
    Group,
    Stack,
    Paper,
    Text,
    Badge,
    SegmentedControl,
    Loader,
    Center,
    Button,
    SimpleGrid,
    Select,
    TextInput,
    ActionIcon,
    Skeleton,
    Divider,
} from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import { useDebouncedValue } from '@mantine/hooks';
import {
    IconNotes,
    IconCalendar,
    IconClock,
    IconFileReport,
    IconArrowsExchange,
    IconUser,
    IconSearch,
    IconChevronLeft,
    IconChevronRight,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { isInternal } from '../lib/permissions';
import api from '../lib/api';
import StatCard from '../components/StatCard';
import type { Activity, ActivityType } from '../types/activity';
```

**Constants (same as current):**
```typescript
const ACTIVITY_ICONS: Record<ActivityType, React.ReactNode> = {
    not: <IconNotes size={16} />,
    meeting: <IconCalendar size={16} />,
    follow_up: <IconClock size={16} />,
    sonlandirma_raporu: <IconFileReport size={16} />,
    status_change: <IconArrowsExchange size={16} />,
};

const ACTIVITY_COLORS: Record<ActivityType, string> = {
    not: 'blue',
    meeting: 'violet',
    follow_up: 'orange',
    sonlandirma_raporu: 'green',
    status_change: 'gray',
};

const OUTCOME_COLORS: Record<string, string> = {
    won: 'green',
    lost: 'red',
    on_hold: 'gray',
    cancelled: 'dark',
};
```

**Date helpers (locale-aware):**

Note: All date formatting functions accept a `locale` parameter derived from `i18n.language` to support bilingual display. In the component, derive it as: `const locale = i18n.language === 'en' ? 'en-US' : 'tr-TR';` using `const { t, i18n } = useTranslation();`.

```typescript
type PeriodType = 'day' | 'week' | 'month' | 'custom';

function getDateRange(periodType: PeriodType, anchor: Date): { from: string; to: string } {
    const toLocal = (d: Date) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    if (periodType === 'day') {
        const day = toLocal(anchor);
        return { from: day, to: day + 'T23:59:59' };
    }
    if (periodType === 'week') {
        const d = new Date(anchor);
        const dayOfWeek = d.getDay();
        const diff = dayOfWeek === 0 ? -6 : 1 - dayOfWeek; // Monday start
        const monday = new Date(d);
        monday.setDate(d.getDate() + diff);
        const sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);
        return { from: toLocal(monday), to: toLocal(sunday) + 'T23:59:59' };
    }
    if (periodType === 'month') {
        const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
        const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
        return { from: toLocal(first), to: toLocal(last) + 'T23:59:59' };
    }
    return { from: '', to: '' };
}

function shiftPeriod(periodType: PeriodType, anchor: Date, direction: 1 | -1): Date {
    const d = new Date(anchor);
    if (periodType === 'day') d.setDate(d.getDate() + direction);
    if (periodType === 'week') d.setDate(d.getDate() + 7 * direction);
    if (periodType === 'month') d.setMonth(d.getMonth() + direction);
    return d;
}

function formatPeriodLabel(periodType: PeriodType, anchor: Date, locale: string): string {
    const opts: Intl.DateTimeFormatOptions =
        periodType === 'day'
            ? { day: 'numeric', month: 'long', year: 'numeric' }
            : periodType === 'month'
            ? { month: 'long', year: 'numeric' }
            : { day: 'numeric', month: 'short' };

    if (periodType === 'week') {
        const { from, to } = getDateRange('week', anchor);
        const f = new Date(from);
        const t = new Date(to);
        return `${f.toLocaleDateString(locale, { day: 'numeric' })} — ${t.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })}`;
    }
    return anchor.toLocaleDateString(locale, opts);
}

function isCurrentPeriod(periodType: PeriodType, anchor: Date): boolean {
    const now = new Date();
    const current = getDateRange(periodType, now);
    const selected = getDateRange(periodType, anchor);
    return current.from === selected.from;
}

function formatDate(iso: string, locale: string) {
    return new Date(iso).toLocaleDateString(locale, {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}

function formatGroupDate(iso: string, locale: string): string {
    const date = new Date(iso);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);

    const toDateStr = (d: Date) => d.toISOString().split('T')[0];
    if (toDateStr(date) === toDateStr(today)) return 'today';
    if (toDateStr(date) === toDateStr(yesterday)) return 'yesterday';
    return date.toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' });
}
```

- [ ] **Step 2: Write the component state and queries**

```typescript
export default function ActivitiesPage() {
    const { t, i18n } = useTranslation();
    const navigate = useNavigate();
    const { user } = useAuth();
    const locale = i18n.language === 'en' ? 'en-US' : 'tr-TR';

    // Date navigation
    const [periodType, setPeriodType] = useState<PeriodType>('week');
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
    const [allActivities, setAllActivities] = useState<Activity[]>([]);

    // Compute date range
    const dateRange = useMemo(() => {
        if (periodType === 'custom') {
            if (customRange[0] && customRange[1]) {
                const toLocal = (d: Date) =>
                    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                return { from: toLocal(customRange[0]), to: toLocal(customRange[1]) + 'T23:59:59' };
            }
            return { from: '', to: '' };
        }
        return getDateRange(periodType, periodAnchor);
    }, [periodType, periodAnchor, customRange]);

    const pageLimit = groupBy !== 'none' ? 100 : 20;

    // Reset page on filter changes
    useEffect(() => {
        setPage(1);
        setAllActivities([]);
    }, [typeFilter, visibilityFilter, createdByFilter, debouncedSearch, dateRange.from, dateRange.to, groupBy]);

    // Activities query
    const { data, isLoading, isFetching } = useQuery<{ data: Activity[]; pagination: { hasNext: boolean; total: number } }>({
        queryKey: ['activities-all', page, pageLimit, typeFilter, visibilityFilter, createdByFilter, debouncedSearch, dateRange.from, dateRange.to],
        queryFn: async () => {
            const params: Record<string, string> = { page: String(page), limit: String(pageLimit) };
            if (typeFilter) params.type = typeFilter;
            if (dateRange.from) params.date_from = dateRange.from;
            if (dateRange.to) params.date_to = dateRange.to;
            if (debouncedSearch) params.search = debouncedSearch;
            if (visibilityFilter) params.visibility = visibilityFilter;
            if (createdByFilter) params.created_by = createdByFilter;
            return (await api.get('/activities/all', { params })).data;
        },
        enabled: periodType !== 'custom' || (!!customRange[0] && !!customRange[1]),
    });

    // Stats query
    const { data: stats, isLoading: statsLoading } = useQuery<{
        meeting: number; not: number; follow_up: number; total: number;
    }>({
        queryKey: ['activities-stats', typeFilter, visibilityFilter, createdByFilter, debouncedSearch, dateRange.from, dateRange.to],
        queryFn: async () => {
            const params: Record<string, string> = {};
            if (typeFilter) params.type = typeFilter;
            if (dateRange.from) params.date_from = dateRange.from;
            if (dateRange.to) params.date_to = dateRange.to;
            if (debouncedSearch) params.search = debouncedSearch;
            if (visibilityFilter) params.visibility = visibilityFilter;
            if (createdByFilter) params.created_by = createdByFilter;
            return (await api.get('/activities/stats', { params })).data;
        },
        enabled: periodType !== 'custom' || (!!customRange[0] && !!customRange[1]),
    });

    // Users query (for created-by filter)
    const { data: activityUsers } = useQuery<{ id: string; email: string }[]>({
        queryKey: ['activities-users'],
        queryFn: async () => (await api.get('/activities/users')).data,
    });

    // Accumulate pages
    useEffect(() => {
        if (!data?.data) return;
        if (page === 1) {
            setAllActivities(data.data);
        } else {
            setAllActivities((prev) => {
                const existingIds = new Set(prev.map((a) => a.id));
                const newItems = data.data.filter((a: Activity) => !existingIds.has(a.id));
                return [...prev, ...newItems];
            });
        }
    }, [data, page]);

    const hasMore = data?.pagination?.hasNext ?? false;
```

- [ ] **Step 3: Write the grouping logic**

```typescript
    // Client-side grouping
    const groupedActivities = useMemo(() => {
        if (groupBy === 'none') return null;

        const groups: { key: string; label: string; color?: string; icon?: React.ReactNode; items: Activity[] }[] = [];
        const groupMap = new Map<string, Activity[]>();

        for (const activity of allActivities) {
            let key: string;
            if (groupBy === 'date') {
                key = new Date(activity.occurred_at).toISOString().split('T')[0];
            } else if (groupBy === 'company') {
                key = activity.company_name || 'unknown';
            } else {
                key = activity.type;
            }
            if (!groupMap.has(key)) groupMap.set(key, []);
            groupMap.get(key)!.push(activity);
        }

        for (const [key, items] of groupMap) {
            let label: string;
            let color: string | undefined;
            let icon: React.ReactNode | undefined;

            if (groupBy === 'date') {
                const formatted = formatGroupDate(key + 'T00:00:00', locale);
                label = formatted === 'today' ? t('activities.today') : formatted === 'yesterday' ? t('activities.yesterday') : formatted;
            } else if (groupBy === 'company') {
                label = key === 'unknown' ? '—' : key;
            } else {
                label = t(`activity.types.${key}`);
                color = ACTIVITY_COLORS[key as ActivityType];
                icon = ACTIVITY_ICONS[key as ActivityType];
            }

            groups.push({ key, label, color, icon, items });
        }

        // Sort groups
        if (groupBy === 'date') {
            groups.sort((a, b) => b.key.localeCompare(a.key)); // newest first
        } else if (groupBy === 'company') {
            groups.sort((a, b) => a.label.localeCompare(b.label));
        }

        return groups;
    }, [allActivities, groupBy, t, locale]);
```

- [ ] **Step 4: Write the JSX — stats cards and date navigation**

```typescript
    const isCurrent = periodType !== 'custom' && isCurrentPeriod(periodType, periodAnchor);

    return (
        <Container size="lg" py="xl">
            <Group justify="space-between" mb="lg">
                <Title order={2}>{t('activities.pageTitle')}</Title>
            </Group>

            {/* Stats Cards */}
            <SimpleGrid cols={{ base: 2, sm: 4 }} mb="lg">
                {statsLoading ? (
                    <>
                        <Skeleton height={90} radius="lg" />
                        <Skeleton height={90} radius="lg" />
                        <Skeleton height={90} radius="lg" />
                        <Skeleton height={90} radius="lg" />
                    </>
                ) : (
                    <>
                        <StatCard
                            title={t('activity.types.meeting')}
                            value={stats?.meeting ?? 0}
                            icon={<IconCalendar size={22} />}
                            color="violet"
                        />
                        <StatCard
                            title={t('activity.types.not')}
                            value={stats?.not ?? 0}
                            icon={<IconNotes size={22} />}
                            color="blue"
                        />
                        <StatCard
                            title={t('activity.types.follow_up')}
                            value={stats?.follow_up ?? 0}
                            icon={<IconClock size={22} />}
                            color="orange"
                        />
                        <StatCard
                            title={t('activities.statsTotal')}
                            value={stats?.total ?? 0}
                            icon={<IconFileReport size={22} />}
                            color="gray"
                        />
                    </>
                )}
            </SimpleGrid>

            {/* Row 1: Date Navigation + Search */}
            <Paper p="md" radius="md" withBorder mb="sm">
                <Group justify="space-between" wrap="wrap" gap="sm">
                    <Group gap="sm" wrap="nowrap">
                        <SegmentedControl
                            size="xs"
                            value={periodType}
                            onChange={(v) => {
                                setPeriodType(v as PeriodType);
                                setPeriodAnchor(new Date());
                            }}
                            data={[
                                { label: t('activities.periodDay'), value: 'day' },
                                { label: t('activities.periodWeek'), value: 'week' },
                                { label: t('activities.periodMonth'), value: 'month' },
                                { label: t('activities.periodCustom'), value: 'custom' },
                            ]}
                        />
                        {periodType !== 'custom' ? (
                            <Group gap={4} wrap="nowrap">
                                <ActionIcon
                                    variant="default"
                                    size="sm"
                                    onClick={() => setPeriodAnchor(shiftPeriod(periodType, periodAnchor, -1))}
                                >
                                    <IconChevronLeft size={14} />
                                </ActionIcon>
                                <Text size="sm" fw={600} style={{ minWidth: 140, textAlign: 'center' }}>
                                    {formatPeriodLabel(periodType, periodAnchor, locale)}
                                </Text>
                                <ActionIcon
                                    variant="default"
                                    size="sm"
                                    disabled={isCurrent}
                                    onClick={() => setPeriodAnchor(shiftPeriod(periodType, periodAnchor, 1))}
                                >
                                    <IconChevronRight size={14} />
                                </ActionIcon>
                                {!isCurrent && (
                                    <Button
                                        variant="subtle"
                                        size="compact-xs"
                                        color="violet"
                                        onClick={() => setPeriodAnchor(new Date())}
                                    >
                                        {t('activities.today')}
                                    </Button>
                                )}
                            </Group>
                        ) : (
                            <DatePickerInput
                                type="range"
                                placeholder={t('activities.dateRange')}
                                value={customRange}
                                onChange={(v) => setCustomRange(v as [Date | null, Date | null])}
                                clearable
                                size="xs"
                            />
                        )}
                    </Group>
                    <TextInput
                        placeholder={t('activities.search')}
                        leftSection={<IconSearch size={14} />}
                        size="xs"
                        value={search}
                        onChange={(e) => setSearch(e.currentTarget.value)}
                        style={{ minWidth: 200 }}
                    />
                </Group>
            </Paper>
```

- [ ] **Step 5: Write the JSX — filters row and grouping**

```typescript
            {/* Row 2: Type Filter + Visibility + Created By */}
            <Paper p="md" radius="md" withBorder mb="sm">
                <Group gap="sm" wrap="wrap">
                    <SegmentedControl
                        size="xs"
                        value={typeFilter}
                        onChange={(v) => setTypeFilter(v)}
                        data={[
                            { label: t('activities.all'), value: '' },
                            { label: t('activities.types.not'), value: 'not' },
                            { label: t('activities.types.meeting'), value: 'meeting' },
                            { label: t('activities.types.follow_up'), value: 'follow_up' },
                        ]}
                    />
                    {isInternal(user?.role || '') && (
                        <Select
                            size="xs"
                            placeholder={t('activities.allVisibility')}
                            value={visibilityFilter || null}
                            onChange={(v) => setVisibilityFilter(v || '')}
                            data={[
                                { label: t('activities.allVisibility'), value: '' },
                                { label: t('activity.visibility_options.internal'), value: 'internal' },
                                { label: t('activity.visibility_options.client'), value: 'client' },
                            ]}
                            clearable
                            style={{ minWidth: 120 }}
                        />
                    )}
                    {activityUsers && activityUsers.length > 0 && (
                        <Select
                            size="xs"
                            placeholder={t('activities.allUsers')}
                            value={createdByFilter || null}
                            onChange={(v) => setCreatedByFilter(v || '')}
                            data={[
                                { label: t('activities.allUsers'), value: '' },
                                ...activityUsers.map((u) => ({ label: u.email, value: u.id })),
                            ]}
                            clearable
                            searchable
                            style={{ minWidth: 180 }}
                        />
                    )}
                </Group>
            </Paper>

            {/* Grouping Control */}
            <Group mb="md">
                <SegmentedControl
                    size="xs"
                    value={groupBy}
                    onChange={(v) => setGroupBy(v as typeof groupBy)}
                    data={[
                        { label: t('activities.groupByNone'), value: 'none' },
                        { label: t('activities.groupByDate'), value: 'date' },
                        { label: t('activities.groupByCompany'), value: 'company' },
                        { label: t('activities.groupByType'), value: 'type' },
                    ]}
                />
            </Group>
```

- [ ] **Step 6: Define ActivityCard local component**

Add this above the `ActivitiesPage` function in the same file. This must be defined before it's used in the JSX in the next step.

```typescript
function ActivityCard({
    activity,
    navigate,
    t,
    locale,
}: {
    activity: Activity;
    navigate: (path: string) => void;
    t: (key: string, fallback?: string) => string;
    locale: string;
}) {
    const color = ACTIVITY_COLORS[activity.type] || 'gray';
    const outcomeColor = OUTCOME_COLORS[activity.outcome || ''] || 'gray';

    return (
        <Paper p="md" radius="md" withBorder>
            <Group justify="space-between" wrap="nowrap" align="flex-start">
                <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
                    {activity.company_name && (
                        <Text
                            size="sm"
                            fw={600}
                            c="blue"
                            style={{ cursor: 'pointer' }}
                            onClick={() => navigate(`/companies/${activity.company_id}`)}
                        >
                            {activity.company_name}
                        </Text>
                    )}
                    <Group gap="xs" wrap="wrap">
                        <Badge
                            size="sm"
                            variant="light"
                            color={color}
                            leftSection={ACTIVITY_ICONS[activity.type]}
                        >
                            {t(`activity.types.${activity.type}`)}
                        </Badge>
                        {activity.outcome && (
                            <Badge size="sm" variant="filled" color={outcomeColor}>
                                {t(`activity.outcomes.${activity.outcome}`, activity.outcome)}
                            </Badge>
                        )}
                        {activity.visibility === 'internal' && (
                            <Badge size="xs" variant="outline" color="gray">
                                {t('activity.internal')}
                            </Badge>
                        )}
                        {activity.contact_name && (
                            <Badge
                                size="xs"
                                variant="light"
                                color="gray"
                                leftSection={<IconUser size={10} />}
                            >
                                {activity.contact_name}
                            </Badge>
                        )}
                    </Group>
                    <Text size="sm" fw={500}>{activity.summary}</Text>
                    {activity.detail && (
                        <Text size="xs" c="dimmed" lineClamp={2}>{activity.detail}</Text>
                    )}
                </Stack>
                <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                    {formatDate(activity.occurred_at, locale)}
                </Text>
            </Group>
        </Paper>
    );
}
```

- [ ] **Step 7: Write the JSX — activity list rendering (flat and grouped)**

```typescript
            {/* Activity List */}
            {isLoading && page === 1 ? (
                <Center py="xl">
                    <Loader size="md" color="violet" />
                </Center>
            ) : allActivities.length === 0 ? (
                <Center py="xl">
                    <Text c="dimmed" fs="italic">{t('activity.noActivities')}</Text>
                </Center>
            ) : groupedActivities ? (
                // Grouped view
                <Stack gap="lg">
                    {groupedActivities.map((group) => (
                        <div key={group.key}>
                            <Group gap="xs" mb="xs">
                                {group.icon}
                                <Text size="sm" fw={700} c={group.color || 'dimmed'}>
                                    {group.label}
                                </Text>
                                <Badge size="sm" variant="light" color={group.color || 'gray'} circle>
                                    {group.items.length}
                                </Badge>
                            </Group>
                            <Stack gap="sm">
                                {group.items.map((activity) => (
                                    <ActivityCard
                                        key={activity.id}
                                        activity={activity}
                                        navigate={navigate}
                                        t={t}
                                        locale={locale}
                                    />
                                ))}
                            </Stack>
                            <Divider my="md" variant="dashed" />
                        </div>
                    ))}
                </Stack>
            ) : (
                // Flat view
                <Stack gap="sm">
                    {allActivities.map((activity) => (
                        <ActivityCard
                            key={activity.id}
                            activity={activity}
                            navigate={navigate}
                            t={t}
                            locale={locale}
                        />
                    ))}
                </Stack>
            )}

            {hasMore && (
                <Center mt="md">
                    <Button
                        variant="subtle"
                        color="gray"
                        onClick={() => setPage((p) => p + 1)}
                        loading={isFetching}
                    >
                        {t('activity.loadMore')}
                    </Button>
                </Center>
            )}
        </Container>
    );
}
```

- [ ] **Step 8: Verify client builds**

Run: `cd client && npm run build 2>&1 | tail -20`
Expected: Build succeeds with no errors.

- [ ] **Step 9: Commit**

```bash
git add client/src/pages/ActivitiesPage.tsx
git commit -m "feat(activities): rewrite activities page with stats, date nav, filters, grouping"
```

---

## Task 6: Manual testing and polish

- [ ] **Step 1: Start the dev server**

Run: `npm run dev`

- [ ] **Step 2: Test date navigation**

Navigate to `/activities`. Verify:
- Default view shows current week
- Segmented control switches between Day/Week/Month/Custom
- Arrow buttons shift the period correctly
- "Bugün" button appears when navigated away and resets to current period
- Next button is disabled on current period
- Custom mode shows DatePickerInput

- [ ] **Step 3: Test filters**

- Type filter: switching between All/Not/Meeting/Follow-up updates the list
- Search: typing text filters by summary/detail with 300ms debounce
- Visibility filter: appears only for internal roles, filters correctly
- Created-by filter: shows users who have created activities, filters correctly

- [ ] **Step 4: Test grouping**

- Switch between Flat/By Date/By Company/By Type
- Verify group headers show correct labels and counts
- Verify "Load More" still works in grouped mode

- [ ] **Step 5: Test stats cards**

- Cards update when filters/date change
- Cards show skeleton while loading
- Counts match the filtered activity list

- [ ] **Step 6: Commit any fixes**

```bash
git add client/src/pages/ActivitiesPage.tsx server/src/routes/activities.ts client/src/locales/tr.json client/src/locales/en.json
git commit -m "fix(activities): polish after manual testing"
```
