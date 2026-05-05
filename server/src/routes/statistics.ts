import { Router, Request, Response } from 'express';
import ExcelJS from 'exceljs';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireTier, requireRole } from '../middleware/auth.js';
import { createLogger } from '../lib/logger.js';
import { getPipelineStageSlugs, getTerminalStageSlugs, getTenantStages } from './settings.js';

const log = createLogger('route:statistics');

const router = Router();

// ─── In-memory cache for overview (per tenant, 30s TTL) ───
interface CachedOverview {
    data: Record<string, unknown>;
    ts: number;
}
const overviewCache = new Map<string, CachedOverview>();
const OVERVIEW_TTL = 30_000; // 30 seconds
const MAX_STATS_CACHE_SIZE = 500;

/** Invalidate overview cache for a tenant (call after stage changes, imports, etc.) */
export function invalidateOverviewCache(tenantId: string) {
    for (const key of overviewCache.keys()) {
        if (key.startsWith(tenantId)) overviewCache.delete(key);
    }
}

function parseDateFilters(req: Request, res: Response): { dateFrom?: string; dateTo?: string } | null {
    const dateFrom = req.query.dateFrom as string | undefined;
    const dateTo = req.query.dateTo as string | undefined;

    if (dateFrom && isNaN(Date.parse(dateFrom))) {
        res.status(400).json({ error: 'Please enter a valid start date' });
        return null;
    }
    if (dateTo && isNaN(Date.parse(dateTo))) {
        res.status(400).json({ error: 'Please enter a valid end date' });
        return null;
    }
    if (dateFrom && dateTo && new Date(dateFrom) > new Date(dateTo)) {
        res.status(400).json({ error: 'Start date must be before end date' });
        return null;
    }

    return { dateFrom, dateTo };
}

function buildCacheKey(tenantId: string, dateFrom?: string, dateTo?: string): string {
    return `${tenantId}:${dateFrom || ''}:${dateTo || ''}`;
}

// GET /api/statistics/overview — Summary stats for dashboard
router.get('/overview', async (req: Request, res: Response): Promise<void> => {
    try {
        const tenantId = req.tenantId!;

        const dateFilters = parseDateFilters(req, res);
        if (!dateFilters) return; // 400 already sent
        const { dateFrom, dateTo } = dateFilters;
        const cacheKey = buildCacheKey(tenantId, dateFrom, dateTo);

        // Check cache first
        const cached = overviewCache.get(cacheKey);
        if (cached && Date.now() - cached.ts < OVERVIEW_TTL) {
            res.json(cached.data);
            return;
        }

        // Build companies query with optional date filters
        let companiesQuery = supabaseAdmin
            .from('companies')
            .select('*', { count: 'exact', head: true })
            .eq('tenant_id', tenantId);
        if (dateFrom) companiesQuery = companiesQuery.gte('created_at', dateFrom);
        if (dateTo) companiesQuery = companiesQuery.lte('created_at', dateTo);

        // Run all counts in parallel (including pipeline stages to avoid extra round-trip)
        const [companiesRes, stagesRes, tenantPipelineStages] = await Promise.all([
            companiesQuery,
            supabaseAdmin.rpc('get_stage_counts', {
                p_tenant_id: tenantId,
                p_date_from: dateFrom || null,
                p_date_to: dateTo || null,
            }),
            getPipelineStageSlugs(tenantId),
        ]);

        if (stagesRes.error) {
            log.error({ err: stagesRes.error }, 'Stage counts RPC error');
        }

        const totalCompanies = companiesRes.count || 0;

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


        // Build stage counts from RPC result
        const stageCounts: Record<string, number> = {};
        for (const row of stagesRes.data || []) {
            stageCounts[row.stage] = Number(row.count);
        }

        const wonCount = stageCounts['won'] || 0;
        const lostCount = stageCounts['lost'] || 0;
        const totalDecided = wonCount + lostCount;
        const conversionRate = totalDecided > 0 ? Math.round((wonCount / totalDecided) * 100) : 0;

        // Active deals = only pipeline-type stages
        const activeDeals = Object.entries(stageCounts)
            .filter(([stage]) => tenantPipelineStages.includes(stage))
            .reduce((sum, [, count]) => sum + count, 0);

        const result = {
            totalCompanies,
            totalContacts,
            activeDeals,
            wonDeals: wonCount,
            conversionRate,
            companiesByStage: stageCounts,
        };

        // Cache result
        if (overviewCache.size >= MAX_STATS_CACHE_SIZE) overviewCache.clear();
        overviewCache.set(cacheKey, { data: result, ts: Date.now() });

        res.json(result);
    } catch (err) {
        log.error({ err }, 'Statistics overview error');
        res.status(500).json({ error: 'Failed to fetch statistics' });
    }
});

// ─── Pipeline cache (per tenant, 30s TTL) ───
const pipelineStatsCache = new Map<string, CachedOverview>();

export function invalidatePipelineStatsCache(tenantId: string) {
    for (const key of pipelineStatsCache.keys()) {
        if (key.startsWith(tenantId)) pipelineStatsCache.delete(key);
    }
}

// GET /api/statistics/pipeline — Funnel data for pipeline stages (pro tier only)
router.get('/pipeline', requireTier('pro'), async (req: Request, res: Response): Promise<void> => {
    try {
        const tenantId = req.tenantId!;

        const dateFilters = parseDateFilters(req, res);
        if (!dateFilters) return; // 400 already sent
        const { dateFrom, dateTo } = dateFilters;
        const cacheKey = buildCacheKey(tenantId, dateFrom, dateTo);

        const cached = pipelineStatsCache.get(cacheKey);
        if (cached && Date.now() - cached.ts < OVERVIEW_TTL) {
            res.json(cached.data);
            return;
        }

        // Fetch stage counts + stage config in parallel
        const [stagesRes, pipelineStages, terminalStages] = await Promise.all([
            supabaseAdmin.rpc('get_stage_counts', {
                p_tenant_id: tenantId,
                p_date_from: dateFrom || null,
                p_date_to: dateTo || null,
            }),
            getPipelineStageSlugs(tenantId),
            getTerminalStageSlugs(tenantId),
        ]);

        if (stagesRes.error) {
            log.error({ err: stagesRes.error }, 'Pipeline stage counts RPC error');
            res.status(500).json({ error: 'Failed to fetch pipeline data' });
            return;
        }

        const stageCounts: Record<string, number> = {};
        for (const row of stagesRes.data || []) {
            stageCounts[row.stage] = Number(row.count);
        }

        const funnel = pipelineStages.map((stage) => ({
            stage,
            count: stageCounts[stage] || 0,
        }));

        const terminal = terminalStages.map((stage) => ({
            stage,
            count: stageCounts[stage] || 0,
        }));

        const result = { funnel, terminal };
        if (pipelineStatsCache.size >= MAX_STATS_CACHE_SIZE) pipelineStatsCache.clear();
        pipelineStatsCache.set(cacheKey, { data: result, ts: Date.now() });

        res.json(result);
    } catch (err) {
        log.error({ err }, 'Statistics pipeline error');
        res.status(500).json({ error: 'Failed to fetch pipeline data' });
    }
});

// GET /api/statistics/company-locations — Companies with geocoded coordinates for globe map
router.get('/company-locations', requireTier('pro'), async (req: Request, res: Response): Promise<void> => {
    try {
        const tenantId = req.tenantId!;

        const dateFilters = parseDateFilters(req, res);
        if (!dateFilters) return;
        const { dateFrom, dateTo } = dateFilters;

        // Only show pipeline + terminal companies on the map
        const allStages = await getTenantStages(tenantId);
        const mapStageSlugs = allStages
            .filter((s) => s.stage_type === 'pipeline' || s.stage_type === 'terminal')
            .map((s) => s.slug);

        let locationsQuery = supabaseAdmin
            .from('companies')
            .select('id, name, location, latitude, longitude, stage')
            .eq('tenant_id', tenantId)
            .in('stage', mapStageSlugs)
            .not('latitude', 'is', null)
            .not('longitude', 'is', null)
            .order('updated_at', { ascending: false })
            .limit(2000);
        if (dateFrom) locationsQuery = locationsQuery.gte('created_at', dateFrom);
        if (dateTo) locationsQuery = locationsQuery.lte('created_at', dateTo);

        let missingQuery = mapStageSlugs.length > 0
            ? supabaseAdmin
                .from('companies')
                .select('*', { count: 'exact', head: true })
                .eq('tenant_id', tenantId)
                .in('stage', mapStageSlugs)
                .not('location', 'is', null)
                .is('latitude', null)
            : null;
        if (missingQuery && dateFrom) missingQuery = missingQuery.gte('created_at', dateFrom);
        if (missingQuery && dateTo) missingQuery = missingQuery.lte('created_at', dateTo);

        const [locationsRes, missingRes] = await Promise.all([
            locationsQuery,
            missingQuery ?? Promise.resolve({ count: 0, error: null }),
        ]);

        if (locationsRes.error) {
            log.error({ err: locationsRes.error }, 'Company locations error');
            res.status(500).json({ error: 'Failed to fetch company locations' });
            return;
        }

        res.json({ 
            data: locationsRes.data || [], 
            missingCount: missingRes.count || 0 
        });
    } catch (err) {
        log.error({ err }, 'Company locations error');
        res.status(500).json({ error: 'Failed to fetch company locations' });
    }
});

// ─── Monthly Report Export ────────────────────────────────────────────────────

interface EmailMessage {
    direction: 'IN' | 'OUT';
    body: string;
    date: string;
}

interface ThreadGroup {
    senderEmail: string;
    companyName: string;
    campaignName: string;
    latestCategory: string;
    matchStatus: string;
    firstReplyAt: string;
    messageCount: number;
    messages: EmailMessage[];
}

function fmt(date: string | null | undefined): string {
    if (!date) return '';
    return new Date(date).toLocaleDateString('tr-TR');
}

function styleHeaderRow(row: ExcelJS.Row): void {
    row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6B4EFF' } };
    row.alignment = { vertical: 'middle', wrapText: false };
    row.height = 22;
}

function styleDataRow(row: ExcelJS.Row, idx: number): void {
    if (idx % 2 === 0) {
        row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8F6FF' } };
    }
}

function autoFit(sheet: ExcelJS.Worksheet, headers: string[]): void {
    sheet.columns.forEach((col, i) => {
        if (!col || !col.eachCell) return;
        const header = headers[i] ?? '';
        let maxLen = header.length;
        col.eachCell({ includeEmpty: false }, (cell) => {
            const v = cell.value ? String(cell.value) : '';
            const lineLen = Math.max(...v.split('\n').map((l) => l.length));
            if (lineLen > maxLen) maxLen = lineLen;
        });
        col.width = Math.min(maxLen + 4, 50);
    });
}

function stripHtml(html: string | null | undefined): string {
    if (!html) return '';
    return html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<\/div>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&nbsp;/g, ' ')
        .replace(/\r\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function cleanEmailBody(raw: string | null | undefined): string {
    const text = stripHtml(raw);
    if (!text) return '';
    // Quote / reply-thread separators
    const patterns = [
        /^From:[ \t]+\S/m,
        /^On [\s\S]+?wrote:/m,          // multi-line Gmail/Outlook quoting
        /^-{3,}[ \t]*(?:original|forwarded)/im,
        /^-{3,}[ \t]*$/m,               // bare --- separator
        /^[ \t]*>/m,
        // Signature separators
        /^--[ \t]*$/m,
        /^_{3,}$/m,
        // Mobile / client signatures
        /^Sent from my /im,
        /^Get Outlook for/im,
        /^iPhone'[ui]mdan gönderildi/im,
    ];
    let splitIndex = text.length;
    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match?.index !== undefined && match.index >= 0) {
            splitIndex = Math.min(splitIndex, match.index);
        }
    }
    const fresh = text.slice(0, splitIndex).trimEnd();
    return fresh || text;
}

function buildThreads(rows: Record<string, unknown>[]): ThreadGroup[] {
    const map = new Map<string, ThreadGroup>();
    for (const row of rows) {
        const campaignId = (row.campaign_id as string) ?? 'no-campaign';
        const senderEmail = (row.sender_email as string) ?? '';
        const key = `${campaignId}:${senderEmail}`;
        if (!map.has(key)) {
            map.set(key, {
                senderEmail,
                companyName: (row.companies as Record<string, string> | null)?.name ?? '',
                campaignName: (row.campaign_name as string) ?? '',
                latestCategory: (row.category as string) ?? '',
                matchStatus: (row.match_status as string) ?? '',
                firstReplyAt: (row.replied_at as string) ?? '',
                messageCount: 0,
                messages: [],
            });
        }
        const thread = map.get(key)!;
        const body = cleanEmailBody(row.reply_body as string | null);
        thread.messages.push({
            direction: (row.direction as 'IN' | 'OUT'),
            body: body.slice(0, 400),
            date: fmt(row.replied_at as string),
        });
        thread.messageCount++;
        // keep last IN category
        if ((row.direction as string) === 'IN' && row.category) {
            thread.latestCategory = row.category as string;
            thread.matchStatus = (row.match_status as string) ?? thread.matchStatus;
        }
    }
    return Array.from(map.values());
}

function buildThreadText(messages: EmailMessage[]): string {
    return messages
        .map((m) => {
            const prefix = m.direction === 'OUT' ? `▶ [Gönderildi] ${m.date}` : `◀ [Alındı] ${m.date}`;
            return `${prefix}\n${m.body}`;
        })
        .join('\n\n');
}

const EMAIL_CATEGORY_LABELS: Record<string, string> = {
    positive: 'Olumlu',
    negative: 'Olumsuz',
    meeting_request: 'Toplantı Talebi',
    waiting_response: 'Yanıt Bekliyor',
    not_interested: 'İlgilenmiyor',
    other: 'Diğer',
};

// GET /api/statistics/report/monthly
router.get('/report/monthly', requireRole('superadmin', 'ops_agent', 'client_admin'), async (req: Request, res: Response): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const now = new Date();
        const year = parseInt((req.query.year as string) || String(now.getFullYear()), 10);
        const month = parseInt((req.query.month as string) || String(now.getMonth() + 1), 10);

        if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
            res.status(400).json({ error: 'Invalid year or month' });
            return;
        }

        const pad = (n: number) => String(n).padStart(2, '0');
        const dateFrom = `${year}-${pad(month)}-01T00:00:00.000Z`;
        const dateTo = new Date(Date.UTC(year, month, 1)).toISOString();

        // Client name: prefer param sent by client (already resolved from auth context)
        const clientNameParam = (req.query.clientName as string | undefined)?.trim();
        const clientNameForFile = clientNameParam && clientNameParam.length > 0 ? clientNameParam : null;

        // ── Parallel queries ───────────────────────────────────────────────────
        const [
            newContactsRes,
            newActivitiesCountRes,
            stageCountsRes,
            newCompaniesDetailRes,
            activitiesRes,
            wonLostRes,
            emailsRes,
        ] = await Promise.all([
            // A1: new contacts count
            supabaseAdmin
                .from('contacts')
                .select('*', { count: 'exact', head: true })
                .eq('tenant_id', tenantId)
                .gte('created_at', dateFrom)
                .lt('created_at', dateTo),
            // A3: new activities count
            supabaseAdmin
                .from('activities')
                .select('*', { count: 'exact', head: true })
                .eq('tenant_id', tenantId)
                .gte('occurred_at', dateFrom)
                .lt('occurred_at', dateTo),
            // B: stage counts (all companies, current snapshot)
            supabaseAdmin.rpc('get_stage_counts', {
                p_tenant_id: tenantId,
                p_date_from: null,
                p_date_to: null,
            }),
            // C: companies with stage change in period (stage_changed_at within range)
            supabaseAdmin
                .from('companies')
                .select('name, stage, stage_changed_at, industry, location')
                .eq('tenant_id', tenantId)
                .gte('stage_changed_at', dateFrom)
                .lt('stage_changed_at', dateTo)
                .order('stage_changed_at', { ascending: false })
                .limit(5000),
            // D: activities detail
            supabaseAdmin
                .from('activities')
                .select('occurred_at, type, summary, created_by, companies(name)')
                .eq('tenant_id', tenantId)
                .neq('type', 'status_change')
                .gte('occurred_at', dateFrom)
                .lt('occurred_at', dateTo)
                .order('occurred_at', { ascending: false })
                .limit(5000),
            // E: won/lost
            supabaseAdmin
                .from('companies')
                .select('name, stage, stage_changed_at, industry, location')
                .eq('tenant_id', tenantId)
                .in('stage', ['won', 'lost'])
                .gte('stage_changed_at', dateFrom)
                .lt('stage_changed_at', dateTo)
                .order('stage_changed_at', { ascending: false })
                .limit(5000),
            // F: email replies (both IN and OUT, for threading)
            supabaseAdmin
                .from('email_replies')
                .select('direction, replied_at, sender_email, reply_body, campaign_id, campaign_name, category, match_status, companies(name)')
                .eq('tenant_id', tenantId)
                .gte('replied_at', dateFrom)
                .lt('replied_at', dateTo)
                .not('raw_payload', 'cs', '{"source":"draft"}')
                .order('replied_at', { ascending: true })
                .limit(10000),
        ]);

        // ── Resolve user names for activities ──────────────────────────────────
        const activities = activitiesRes.data ?? [];
        const uniqueUids = [...new Set(activities.map((a: Record<string, unknown>) => a.created_by as string).filter(Boolean))];
        const userNames = new Map<string, string>();
        await Promise.all(
            uniqueUids.slice(0, 50).map(async (uid) => {
                const { data } = await supabaseAdmin.auth.admin.getUserById(uid);
                if (data?.user) {
                    const u = data.user;
                    userNames.set(uid, u.user_metadata?.full_name || u.email || uid);
                }
            })
        );

        // ── Stage config (with display names) + tenant name ───────────────────
        const [{ data: stagesWithNames }, { data: tenantRow }] = await Promise.all([
            supabaseAdmin
                .from('pipeline_stages')
                .select('slug, display_name, stage_type, sort_order')
                .eq('tenant_id', tenantId)
                .eq('is_active', true)
                .order('sort_order', { ascending: true }),
            supabaseAdmin
                .from('tenants')
                .select('name')
                .eq('id', tenantId)
                .single(),
        ]);
        const stageNameMap = new Map<string, string>((stagesWithNames ?? []).map((s) => [s.slug, s.display_name]));
        const stageTypeMap = new Map<string, string>((stagesWithNames ?? []).map((s) => [s.slug, s.stage_type]));
        const stageSortedSlugs: string[] = (stagesWithNames ?? []).map((s) => s.slug);
        const stageLabel = (slug: string) => stageNameMap.get(slug) ?? slug;
        const resolvedName = clientNameForFile ?? tenantRow?.name ?? 'Client';
        const tenantName = resolvedName.replace(/[^a-zA-Z0-9ğüşıöçĞÜŞİÖÇ\s-]/g, '').trim() || 'Client';

        // ── Won/Lost counts ────────────────────────────────────────────────────
        const stageCounts: Record<string, number> = {};
        for (const row of stageCountsRes.data ?? []) {
            stageCounts[row.stage] = Number(row.count);
        }
        const wonCount = (wonLostRes.data ?? []).filter((c: Record<string, unknown>) => c.stage === 'won').length;
        const lostCount = (wonLostRes.data ?? []).filter((c: Record<string, unknown>) => c.stage === 'lost').length;
        const totalDecided = wonCount + lostCount;
        const conversionRate = totalDecided > 0 ? Math.round((wonCount / totalDecided) * 100) : 0;

        // ── Build email threads ────────────────────────────────────────────────
        const threads = buildThreads(emailsRes.data ?? []);
        const inboundCount = (emailsRes.data ?? []).filter((r: Record<string, unknown>) => r.direction === 'IN').length;

        // ── Email category breakdown ───────────────────────────────────────────
        const categoryBreakdown: Record<string, number> = {};
        for (const r of (emailsRes.data ?? []) as Record<string, unknown>[]) {
            if (r.direction !== 'IN') continue;
            const cat = (r.category as string) || 'other';
            categoryBreakdown[cat] = (categoryBreakdown[cat] || 0) + 1;
        }

        // ── Build workbook ─────────────────────────────────────────────────────
        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'LeadHub / TG Core';
        workbook.created = new Date();

        const monthLabel = `${year}-${pad(month)}`;

        // ── Sheet 1: Özet ──────────────────────────────────────────────────────
        const summarySheet = workbook.addWorksheet('Özet');
        summarySheet.addRow(['Aylık Rapor', monthLabel]);
        summarySheet.addRow([]);
        summarySheet.addRow(['Metrik', 'Değer']);
        styleHeaderRow(summarySheet.getRow(3));
        const summaryData = [
            ['Yeni Kişi', newContactsRes.count ?? 0],
            ['Yeni Aktivite', newActivitiesCountRes.count ?? 0],
            ['Aşama Değişikliği', newCompaniesDetailRes.data?.length ?? 0],
            ['Kazanılan (bu ay)', wonCount],
            ['Kaybedilen (bu ay)', lostCount],
            ['Dönüşüm Oranı', `${conversionRate}%`],
            ['Toplam E-posta Yanıtı (gelen)', inboundCount],
        ];
        let si = 4;
        for (const row of summaryData) {
            styleDataRow(summarySheet.addRow(row), si++);
        }
        summarySheet.addRow([]);
        summarySheet.addRow(['E-posta Kategori Dağılımı', '']);
        styleHeaderRow(summarySheet.getRow(si + 1));
        si += 2;
        for (const [cat, cnt] of Object.entries(categoryBreakdown)) {
            styleDataRow(summarySheet.addRow([EMAIL_CATEGORY_LABELS[cat] ?? cat, cnt]), si++);
        }
        summarySheet.getColumn(1).width = 34;
        summarySheet.getColumn(2).width = 18;

        // ── Sheet 2: Sahne Dağılımı ────────────────────────────────────────────
        const stageSheet = workbook.addWorksheet('Sahne Dağılımı');
        const stageHeaders = ['Aşama', 'Şirket Sayısı', 'Oran (%)'];
        stageSheet.addRow(stageHeaders);
        styleHeaderRow(stageSheet.getRow(1));
        const pipelineTerminalCounts = stageSortedSlugs
            .filter((slug) => stageTypeMap.get(slug) !== 'initial')
            .map((slug) => [slug, stageCounts[slug] ?? 0] as [string, number]);
        const totalStageCompanies = pipelineTerminalCounts.reduce((s, [, v]) => s + v, 0);
        let stIdx = 2;
        for (const [slug, count] of pipelineTerminalCounts) {
            const pct = totalStageCompanies > 0 ? ((count / totalStageCompanies) * 100).toFixed(1) : '0.0';
            styleDataRow(stageSheet.addRow([stageLabel(slug), count, `${pct}%`]), stIdx++);
        }
        autoFit(stageSheet, stageHeaders);

        // ── Sheet 3: Aşama Değişiklikleri ─────────────────────────────────────
        const stageChgSheet = workbook.addWorksheet('Aşama Değişiklikleri');
        const stageChgHeaders = ['Değişiklik Tarihi', 'Şirket', 'Mevcut Aşama', 'Sektör', 'Konum'];
        stageChgSheet.addRow(stageChgHeaders);
        styleHeaderRow(stageChgSheet.getRow(1));
        let scIdx = 2;
        for (const co of (newCompaniesDetailRes.data ?? []) as Record<string, unknown>[]) {
            styleDataRow(stageChgSheet.addRow([
                fmt(co.stage_changed_at as string),
                co.name ?? '',
                stageLabel(co.stage as string),
                co.industry ?? '',
                co.location ?? '',
            ]), scIdx++);
        }
        autoFit(stageChgSheet, stageChgHeaders);

        // ── Sheet 4: Aktiviteler ───────────────────────────────────────────────
        const actSheet = workbook.addWorksheet('Aktiviteler');
        const actHeaders = ['Tarih', 'Tür', 'Şirket', 'Özet', 'Oluşturan'];
        actSheet.addRow(actHeaders);
        styleHeaderRow(actSheet.getRow(1));
        let actIdx = 2;
        for (const act of activities as Record<string, unknown>[]) {
            const company = (act.companies as Record<string, string> | null)?.name ?? '';
            const creator = userNames.get(act.created_by as string) ?? '';
            styleDataRow(actSheet.addRow([
                fmt(act.occurred_at as string),
                act.type ?? '',
                company,
                act.summary ?? '',
                creator,
            ]), actIdx++);
        }
        autoFit(actSheet, actHeaders);

        // ── Sheet 5: Kazanılan / Kaybedilen ───────────────────────────────────
        const wlSheet = workbook.addWorksheet('Kazanılan-Kaybedilen');
        const wlHeaders = ['Şirket Adı', 'Sonuç', 'Sonuç Tarihi', 'Sektör', 'Konum'];
        wlSheet.addRow(wlHeaders);
        styleHeaderRow(wlSheet.getRow(1));
        let wlIdx = 2;
        for (const co of (wonLostRes.data ?? []) as Record<string, unknown>[]) {
            const outcome = co.stage === 'won' ? 'Kazanıldı' : 'Kaybedildi';
            styleDataRow(wlSheet.addRow([
                co.name ?? '',
                outcome,
                fmt(co.stage_changed_at as string),
                co.industry ?? '',
                co.location ?? '',
            ]), wlIdx++);
        }
        autoFit(wlSheet, wlHeaders);

        // ── Sheet 6: E-posta Konuşmaları ───────────────────────────────────────
        const emailSheet = workbook.addWorksheet('E-posta Konuşmaları');
        const emailHeaders = ['İlk Yanıt Tarihi', 'Gönderen (E-posta)', 'Şirket', 'Kategori', 'Mesaj Sayısı', 'Konuşma Geçmişi', 'Kampanya', 'Eşleşme'];
        emailSheet.addRow(emailHeaders);
        styleHeaderRow(emailSheet.getRow(1));
        let emIdx = 2;
        for (const thread of threads) {
            const catLabel = EMAIL_CATEGORY_LABELS[thread.latestCategory] ?? thread.latestCategory ?? '';
            const matchLabel = thread.matchStatus === 'matched' ? 'Eşleşti' : 'Eşleşmedi';
            const threadText = buildThreadText(thread.messages);
            const row = emailSheet.addRow([
                fmt(thread.firstReplyAt),
                thread.senderEmail,
                thread.companyName,
                catLabel,
                thread.messageCount,
                threadText,
                thread.campaignName,
                matchLabel,
            ]);
            styleDataRow(row, emIdx);
            row.height = Math.min(18 + thread.messageCount * 32, 200);
            emIdx++;
        }
        emailSheet.getColumn(6).alignment = { wrapText: true, vertical: 'top' };
        emailSheet.getColumn(6).width = 60;
        // autoFit for other columns only
        const emailAutoFitHeaders = emailHeaders.filter((_, i) => i !== 5);
        const emailAutoFitCols = [1, 2, 3, 4, 5, 7, 8];
        emailAutoFitCols.forEach((ci, i) => {
            const col = emailSheet.getColumn(ci);
            const header = emailAutoFitHeaders[i] ?? '';
            let maxLen = header.length;
            col.eachCell({ includeEmpty: false }, (cell) => {
                const v = cell.value ? String(cell.value) : '';
                if (v.length > maxLen) maxLen = v.length;
            });
            col.width = Math.min(maxLen + 4, 40);
        });

        // ── Stream response ────────────────────────────────────────────────────
        const safeName = tenantName.replace(/\s+/g, '-');
        const filename = `${safeName}-${year}-${pad(month)}-TG-Rapor.xlsx`;
        const encodedFilename = encodeURIComponent(filename);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${encodedFilename}"; filename*=UTF-8''${encodedFilename}`);
        await workbook.xlsx.write(res);
        res.end();
    } catch (err) {
        log.error({ err }, 'Monthly report error');
        if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to generate report' });
        } else {
            res.end();
        }
    }
});

export default router;