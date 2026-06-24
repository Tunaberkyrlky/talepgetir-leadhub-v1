/**
 * Digest Data — haftada-2 özet mailinin içerik bloklarını tenant başına toplar.
 *
 * Mail ve aktiviteler ÖNEME GÖRE gruplanır:
 *   - mailler   → İlgili/Toplantı (INTERESTED, MEETING_BOOKED) tam liste; diğer
 *                 etiketler rozet+sayı (İlgisiz, Ofis dışı, Otomatik, Etiketsiz…)
 *   - aktivite  → toplantı/takip/sonlandırma tam liste; notlar rozet+sayı
 *
 * Sayılar mevcut RPC'lerle: get_email_reply_stats (046/049), get_stage_counts (017).
 * Pencere mantığı için bkz. [[dailyDigest.ts]].
 */

import { supabaseAdmin } from '../supabase.js';
import { createLogger } from '../logger.js';

const log = createLogger('digestData');

export interface DueItem {
    id: string;
    company_id: string;
    type: 'meeting' | 'follow_up';
    summary: string;
    occurred_at: string;
    companies?: { name: string } | null;
}

export interface ActivityItem {
    id: string;
    company_id: string;
    type: string;
    summary: string;
    created_at: string;
    companies?: { name: string } | null;
}

export interface ReplyItem {
    sender_email: string;
    subject: string | null;
    label: string | null;
    replied_at: string;
    company_id: string | null;
    companies?: { name: string } | null;
}

/** Önemsiz grup için "etiket/tip → sayı" rozeti. key ham etiket/tip, çeviri şablonda. */
export interface CountBadge {
    key: string;
    count: number;
}

export interface PipelineStageStat {
    slug: string;
    label: string;       // display_name
    stageType: string;   // 'initial' | 'pipeline' | 'terminal'
    count: number;
}

export interface TenantDigestData {
    positiveReplies: number;   // window içinde INTERESTED yanıt sayısı (stat)
    awaitingReplies: number;   // canlı snapshot: şu an yanıt bekleyen thread sayısı
    replies: {
        important: ReplyItem[];      // İlgili + Toplantı, tam liste
        otherBadges: CountBadge[];   // diğer etiketler, rozet+sayı
    };
    addedActivities: {
        total: number;               // status_change + campaign_email hariç
        important: ActivityItem[];   // toplantı/takip/sonlandırma, tam liste
        otherBadges: CountBadge[];   // not vb., rozet+sayı
    };
    dueItems: DueItem[];       // [windowEnd, dueUntil) içindeki toplantı/followup'lar
    newCompanies: number;
    newContacts: number;
    pipeline: PipelineStageStat[]; // anlık dağılım (sort_order)
}

interface ReplyStatsRow {
    total: number; unread: number; matched: number; unmatched: number;
    interested: number; awaiting: number;
}

const IMPORTANT_REPLY_LABELS = ['INTERESTED', 'MEETING_BOOKED'];
const IMPORTANT_ACTIVITY_TYPES = ['meeting', 'follow_up', 'sonlandirma_raporu'];
const TOTAL_EXCLUDE_TYPES = ['status_change', 'campaign_email']; // otomatik üretilen, "eklenen" sayılmaz
const LIST_LIMIT = 15;

function sortBadges(map: Record<string, number>): CountBadge[] {
    return Object.entries(map)
        .filter(([, n]) => n > 0)
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count);
}

/**
 * Bir tenant için özet verisini toplar.
 * @param windowStart retrospektif blokların başlangıcı (önceki digest'in window_end'i)
 * @param windowEnd   retrospektif blokların sonu (= şimdi)
 * @param dueUntil    "vadesi gelen" ileri penceresinin sonu (sonraki digest günü)
 */
export async function collectTenantDigest(
    tenantId: string,
    windowStart: string,
    windowEnd: string,
    dueUntil: string,
): Promise<TenantDigestData> {
    const [
        replyWindow, replyLive, importantReplies, replyLabels,
        addedCounts, importantActivities,
        due, newCompanies, newContacts, stageCounts, stages,
    ] = await Promise.all([
        // Pozitif yanıt (dönem)
        supabaseAdmin
            .rpc('get_email_reply_stats', { p_tenant_id: tenantId, p_date_from: windowStart, p_date_to: windowEnd })
            .single(),
        // Yanıt bekleyen (canlı snapshot)
        supabaseAdmin
            .rpc('get_email_reply_stats', { p_tenant_id: tenantId, p_date_from: null, p_date_to: null })
            .single(),
        // Önemli yanıtlar — İlgili + Toplantı, tam liste
        supabaseAdmin
            .from('email_replies')
            .select('sender_email, subject, label, replied_at, company_id, companies(name)')
            .eq('tenant_id', tenantId)
            .eq('direction', 'IN')
            .in('label', IMPORTANT_REPLY_LABELS)
            .gte('replied_at', windowStart)
            .lt('replied_at', windowEnd)
            .order('replied_at', { ascending: false })
            .limit(LIST_LIMIT),
        // Tüm gelen yanıt etiketleri (rozet sayıları için)
        supabaseAdmin
            .from('email_replies')
            .select('label')
            .eq('tenant_id', tenantId)
            .eq('direction', 'IN')
            .gte('replied_at', windowStart)
            .lt('replied_at', windowEnd),
        // Eklenen aktiviteler — sayım (tipe göre, tüm pencere)
        supabaseAdmin
            .from('activities')
            .select('type')
            .eq('tenant_id', tenantId)
            .gte('created_at', windowStart)
            .lt('created_at', windowEnd),
        // Önemli aktiviteler — toplantı/takip/sonlandırma, tam liste
        supabaseAdmin
            .from('activities')
            .select('id, company_id, type, summary, created_at, companies(name)')
            .eq('tenant_id', tenantId)
            .in('type', IMPORTANT_ACTIVITY_TYPES)
            .gte('created_at', windowStart)
            .lt('created_at', windowEnd)
            .order('created_at', { ascending: false })
            .limit(LIST_LIMIT),
        // Vadesi gelen toplantı/followup
        supabaseAdmin
            .from('activities')
            .select('id, company_id, type, summary, occurred_at, companies(name)')
            .eq('tenant_id', tenantId)
            .in('type', ['meeting', 'follow_up'])
            .gte('occurred_at', windowEnd)
            .lt('occurred_at', dueUntil)
            .order('occurred_at', { ascending: true })
            .limit(50),
        // Yeni şirket
        supabaseAdmin
            .from('companies')
            .select('id', { count: 'exact', head: true })
            .eq('tenant_id', tenantId)
            .gte('created_at', windowStart)
            .lt('created_at', windowEnd),
        // Yeni kişi
        supabaseAdmin
            .from('contacts')
            .select('id', { count: 'exact', head: true })
            .eq('tenant_id', tenantId)
            .gte('created_at', windowStart)
            .lt('created_at', windowEnd),
        // Pipeline anlık dağılım
        supabaseAdmin.rpc('get_stage_counts', { p_tenant_id: tenantId, p_date_from: null, p_date_to: null }),
        // Stage gösterim adları
        supabaseAdmin
            .from('pipeline_stages')
            .select('slug, display_name, stage_type, sort_order')
            .eq('tenant_id', tenantId)
            .eq('is_active', true)
            .order('sort_order', { ascending: true }),
    ]);

    if (replyWindow.error) log.warn({ err: replyWindow.error, tenantId }, 'reply stats (window) failed');
    if (replyLive.error) log.warn({ err: replyLive.error, tenantId }, 'reply stats (live) failed');
    if (importantReplies.error) log.warn({ err: importantReplies.error, tenantId }, 'important replies failed');
    if (replyLabels.error) log.warn({ err: replyLabels.error, tenantId }, 'reply labels failed');
    if (addedCounts.error) log.warn({ err: addedCounts.error, tenantId }, 'added activities count failed');
    if (importantActivities.error) log.warn({ err: importantActivities.error, tenantId }, 'important activities failed');
    if (due.error) log.warn({ err: due.error, tenantId }, 'due activities query failed');
    if (stageCounts.error) log.warn({ err: stageCounts.error, tenantId }, 'stage counts failed');

    const windowStats = (replyWindow.data as ReplyStatsRow | null);
    const liveStats = (replyLive.data as ReplyStatsRow | null);

    // Yanıt rozetleri: önemli etiketler hariç, etiketsiz → 'OTHER'.
    const labelCounts: Record<string, number> = {};
    for (const row of (replyLabels.data as { label: string | null }[] | null) || []) {
        const key = row.label || 'OTHER';
        if (IMPORTANT_REPLY_LABELS.includes(key)) continue;
        labelCounts[key] = (labelCounts[key] || 0) + 1;
    }

    // Aktivite tip sayıları.
    const byType: Record<string, number> = {};
    for (const row of (addedCounts.data as { type: string }[] | null) || []) {
        byType[row.type] = (byType[row.type] || 0) + 1;
    }
    const addedTotal = Object.entries(byType)
        .filter(([t]) => !TOTAL_EXCLUDE_TYPES.includes(t))
        .reduce((sum, [, n]) => sum + n, 0);
    // Aktivite rozetleri: önemli ve hariç-tutulan tipler dışındakiler (ör. not).
    const activityBadgeMap: Record<string, number> = {};
    for (const [t, n] of Object.entries(byType)) {
        if (IMPORTANT_ACTIVITY_TYPES.includes(t) || TOTAL_EXCLUDE_TYPES.includes(t)) continue;
        activityBadgeMap[t] = n;
    }

    // Pipeline: slug→count haritasını stage adlarıyla birleştir.
    const countMap = new Map<string, number>();
    for (const row of (stageCounts.data as { stage: string; count: number }[] | null) || []) {
        countMap.set(row.stage, Number(row.count));
    }
    const pipeline: PipelineStageStat[] = ((stages.data as { slug: string; display_name: string; stage_type: string }[] | null) || [])
        .map((s) => ({
            slug: s.slug,
            label: s.display_name,
            stageType: s.stage_type,
            count: countMap.get(s.slug) || 0,
        }));

    return {
        positiveReplies: Number(windowStats?.interested ?? 0),
        awaitingReplies: Number(liveStats?.awaiting ?? 0),
        replies: {
            important: ((importantReplies.data as unknown as ReplyItem[]) || []),
            otherBadges: sortBadges(labelCounts),
        },
        addedActivities: {
            total: addedTotal,
            important: ((importantActivities.data as unknown as ActivityItem[]) || []),
            otherBadges: sortBadges(activityBadgeMap),
        },
        dueItems: ((due.data as unknown as DueItem[]) || []),
        newCompanies: newCompanies.count || 0,
        newContacts: newContacts.count || 0,
        pipeline,
    };
}

function badgeSum(badges: CountBadge[]): number {
    return badges.reduce((s, b) => s + b.count, 0);
}

/**
 * Özet "boş" mu? Yeni içerik yoksa mail atmayız (skipped_empty).
 * Yanıt bekleyen (awaiting) standing bir metrik olduğundan boşluk kontrolüne dahil edilmez.
 */
export function isDigestEmpty(d: TenantDigestData): boolean {
    const repliesTotal = d.replies.important.length + badgeSum(d.replies.otherBadges);
    return (
        d.positiveReplies === 0 &&
        d.addedActivities.total === 0 &&
        repliesTotal === 0 &&
        d.dueItems.length === 0 &&
        d.newCompanies === 0 &&
        d.newContacts === 0
    );
}

/** Log/meta için içerik öğesi toplamı. */
export function digestItemCount(d: TenantDigestData): number {
    const repliesTotal = d.replies.important.length + badgeSum(d.replies.otherBadges);
    return (
        d.positiveReplies +
        d.awaitingReplies +
        d.addedActivities.total +
        repliesTotal +
        d.dueItems.length +
        d.newCompanies +
        d.newContacts
    );
}
