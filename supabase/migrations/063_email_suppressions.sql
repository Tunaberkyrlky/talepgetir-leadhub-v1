-- ============================================================================
-- 063: Kalıcı bastırma listesi (suppression) — deliverability (task-5)
--
-- Bir adres bir kez "kötü" olarak işaretlenince (hard bounce / abonelikten çıkma /
-- manuel / şikayet) o tenant için BİR DAHA gönderim yapılmaz. Bu, gönderen kutu
-- itibarını korur: ölü/istemeyen adreslere tekrar mail atmak spam sinyali üretir.
--
-- (tenant_id, email) UNIQUE → aynı adres tenant başına tek satır; ikinci işaret
-- (ör. önce bounce, sonra manuel) çakışmayı sessizce yutar (ON CONFLICT DO NOTHING).
-- email HER ZAMAN küçük harf saklanır (uygulama katmanı lowercase yazar).
--
-- RLS deseni 021_email_replies ile aynı: tenant izolasyonu + superadmin override.
-- Sunucu supabaseAdmin (service role) ile yazdığı için RLS'i baypas eder; politikalar
-- doğrudan istemci/PostgREST erişimi için güvenlik ağıdır.
-- ============================================================================

CREATE TABLE email_suppressions (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- Küçük harfli alıcı adresi (uygulama normalize eder).
    email              TEXT NOT NULL,
    -- Bastırma nedeni. hard_bounce/complaint → itibar koruması; unsubscribe → yasal
    -- zorunluluk; manual → operatör kararı.
    reason             TEXT NOT NULL CHECK (reason IN ('hard_bounce', 'unsubscribe', 'manual', 'complaint')),
    -- Bastırmayı tetikleyen kampanya (biliniyorsa). Kampanya silinirse kayıt kalır,
    -- yalnız kaynak referansı boşalır (adres yine bastırılmış olmalı).
    source_campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ DEFAULT now(),
    UNIQUE(tenant_id, email)
);

-- UNIQUE(tenant_id, email) zaten (tenant_id, email) indexini kurar → gönderim-anı
-- bastırma sorgusu (tenant + email eşitliği) bu indexi kullanır. Yönetim listesi için
-- ayrıca tarihe göre azalan bir index ekleriz.
CREATE INDEX idx_email_suppressions_tenant_created
    ON email_suppressions (tenant_id, created_at DESC);

ALTER TABLE email_suppressions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "email_suppressions_select" ON email_suppressions
    FOR SELECT USING (
        tenant_id = get_user_tenant_id() OR is_superadmin()
    );

CREATE POLICY "email_suppressions_insert" ON email_suppressions
    FOR INSERT WITH CHECK (
        tenant_id = get_user_tenant_id() OR is_superadmin()
    );

CREATE POLICY "email_suppressions_update" ON email_suppressions
    FOR UPDATE USING (
        tenant_id = get_user_tenant_id() OR is_superadmin()
    );

CREATE POLICY "email_suppressions_delete" ON email_suppressions
    FOR DELETE USING (
        tenant_id = get_user_tenant_id() OR is_superadmin()
    );

-- ============================================================================
-- campaign_enrollments: 'skipped_suppressed' durumu eklenir.
--
-- Gönderim-anı bastırma kapısı, alıcısı bastırma listesinde olan bir kaydı
-- SESSİZ göndermek yerine bu duruma çeker → istatistikte görünür, zamanlayıcı
-- (status='active' arar) bir daha almaz. 'skipped_invalid' (062) ile aynı desen:
-- terminal, next_scheduled_at=null, skip_reason nedeni taşır.
--
-- 062'deki inline CHECK'i düşürüp yeni değerle yeniden kurarız (isim 032'den beri
-- 'campaign_enrollments_status_check').
-- ============================================================================
ALTER TABLE campaign_enrollments
    DROP CONSTRAINT IF EXISTS campaign_enrollments_status_check;

ALTER TABLE campaign_enrollments
    ADD CONSTRAINT campaign_enrollments_status_check
    CHECK (status IN (
        'active', 'completed', 'paused',
        'replied', 'bounced', 'unsubscribed',
        'skipped_invalid', 'skipped_suppressed'
    ));
