-- ============================================================================
-- 033: Activities tablosuna kampanya referans kolonları
-- Hibrit v2: sadece 2 kolon — scheduling state enrollments'ta tutulur
-- Gönderilmiş campaign email'ler activities'te bir kayıt olarak oluşturulur
-- ============================================================================

ALTER TABLE activities
    ADD COLUMN campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL;

ALTER TABLE activities
    ADD COLUMN enrollment_id UUID REFERENCES campaign_enrollments(id) ON DELETE SET NULL;

-- Kampanya bazlı sorgular (stats, timeline filtresi)
CREATE INDEX idx_activities_campaign
    ON activities(campaign_id)
    WHERE campaign_id IS NOT NULL;

-- type CHECK constraint'e campaign_email ekle
ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_type_check;
ALTER TABLE activities ADD CONSTRAINT activities_type_check
    CHECK (type IN ('not', 'meeting', 'follow_up', 'sonlandirma_raporu', 'status_change', 'campaign_email'));
