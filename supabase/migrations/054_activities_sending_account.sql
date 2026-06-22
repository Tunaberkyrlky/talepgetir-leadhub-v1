-- Kampanya mailinin hangi gönderen kutudan gittiğini kaydeder.
-- Kutu-başı günlük limit (per-inbox limit) ve gönderim analizi için kullanılır.
ALTER TABLE activities ADD COLUMN IF NOT EXISTS sending_account TEXT;

-- Kutu-başı günlük sayım sorgusu için kısmi index (yalnız gönderen kutusu olan kayıtlar).
CREATE INDEX IF NOT EXISTS idx_activities_sending_account
    ON activities (tenant_id, sending_account, occurred_at)
    WHERE sending_account IS NOT NULL;
