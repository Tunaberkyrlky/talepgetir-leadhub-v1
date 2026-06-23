-- Adım-bazlı kampanya analizi için: her campaign_email aktivitesini hangi adımın
-- (step_order) gönderdiğini kaydet. Geçmiş kayıtlar NULL kalır → kırılımda "bilinmiyor".
ALTER TABLE activities ADD COLUMN IF NOT EXISTS campaign_step_order INTEGER;

-- Kampanya başına adım kırılımı sorgusu için kısmi index.
CREATE INDEX IF NOT EXISTS idx_activities_campaign_step
    ON activities(campaign_id, campaign_step_order)
    WHERE campaign_step_order IS NOT NULL;
