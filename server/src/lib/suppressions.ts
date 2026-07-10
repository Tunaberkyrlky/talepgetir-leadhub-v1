/**
 * Suppression list — kalıcı "bir daha gönderme" kaydı (task-5, deliverability).
 *
 * Bir adres hard bounce / abonelikten-çıkma / şikayet / manuel işaretlenince
 * email_suppressions'a yazılır. Kampanya motoru her gönderim öncesi bu listeyi
 * kontrol eder (filterSuppressed) — ölü/istemeyen adreslere tekrar mail atmak
 * gönderen kutu itibarını bozan bir spam sinyalidir.
 *
 * email HER ZAMAN küçük harfe normalize edilerek okunur/yazılır; DB'deki
 * UNIQUE(tenant_id, email) buna güvenir.
 */
import { supabaseAdmin } from './supabase.js';
import { createLogger } from './logger.js';

const log = createLogger('suppressions');

export type SuppressionReason = 'hard_bounce' | 'unsubscribe' | 'manual' | 'complaint';

function norm(email: string): string {
    return (email || '').trim().toLowerCase();
}

/**
 * Bir adresi bastırma listesine ekler (idempotent). Zaten varsa (aynı tenant+email)
 * UNIQUE çakışması sessizce yutulur — ilk neden korunur (bounce sonrası manuel gibi
 * ikinci işaret satırı değiştirmez). Geçersiz/boş email no-op.
 *
 * Döner: yeni satır eklendiyse true, zaten kayıtlıysa/atlandıysa false.
 */
export async function addSuppression(params: {
    tenantId: string;
    email: string;
    reason: SuppressionReason;
    sourceCampaignId?: string | null;
}): Promise<boolean> {
    const email = norm(params.email);
    if (!email || !params.tenantId) return false;

    const { data, error } = await supabaseAdmin
        .from('email_suppressions')
        .insert({
            tenant_id: params.tenantId,
            email,
            reason: params.reason,
            source_campaign_id: params.sourceCampaignId || null,
        })
        .select('id');

    if (error) {
        // 23505 = UNIQUE(tenant_id, email) — zaten bastırılmış, başarı say.
        if (error.code === '23505') return false;
        log.warn({ err: error, tenantId: params.tenantId, reason: params.reason }, 'Suppression insert failed');
        return false;
    }
    if ((data?.length || 0) > 0) {
        log.info({ tenantId: params.tenantId, email, reason: params.reason }, 'Address suppressed');
        return true;
    }
    return false;
}

/** Tek adres bastırılmış mı? Tek indexli sorgu (tenant_id + email eşitliği). */
export async function isSuppressed(tenantId: string, email: string): Promise<boolean> {
    const e = norm(email);
    if (!e) return false;
    const { data } = await supabaseAdmin
        .from('email_suppressions')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('email', e)
        .limit(1)
        .maybeSingle();
    return !!data;
}

/**
 * Bir grup (tenant, email) çiftini tek sorguda kontrol eder → bastırılmış olanların
 * "tenantId|email" (email küçük harf) anahtar kümesini döner. Zamanlayıcı bir tick'te
 * çok kayıt işlerken tek batch sorgu için (N ayrı sorgu yerine).
 *
 * Çiftler birden çok tenant'a yayılabildiğinden hem tenant_id hem email IN listesiyle
 * çekip sonucu uygulama tarafında tam çift bazında eşleriz (yanlış-tenant eşleşmesi
 * anahtarda tenant olduğu için imkânsız).
 */
export async function filterSuppressed(
    pairs: Array<{ tenantId: string; email: string }>,
): Promise<Set<string>> {
    const suppressed = new Set<string>();
    if (pairs.length === 0) return suppressed;

    const tenantIds = Array.from(new Set(pairs.map((p) => p.tenantId).filter(Boolean)));
    const emails = Array.from(new Set(pairs.map((p) => norm(p.email)).filter(Boolean)));
    if (tenantIds.length === 0 || emails.length === 0) return suppressed;

    const { data, error } = await supabaseAdmin
        .from('email_suppressions')
        .select('tenant_id, email')
        .in('tenant_id', tenantIds)
        .in('email', emails);

    if (error) {
        // Fail-open: bastırma sorgusu patlarsa gönderimi engellemeyiz (gönderim-anı
        // tekil geçersizlik kontrolü ve async bounce yakalama ikinci savunmadır).
        log.warn({ err: error }, 'Batch suppression lookup failed (fail-open)');
        return suppressed;
    }
    for (const r of data || []) {
        suppressed.add(`${r.tenant_id}|${norm(r.email as string)}`);
    }
    return suppressed;
}
