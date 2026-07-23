-- 069: campaignEngine idempotency guard için activities(enrollment_id, campaign_step_order) indeksi.
-- Gönderim öncesi "bu enrollment bu adım için zaten gönderildi mi?" kontrolünü hızlandırır
-- (mükerrer mail önleme, #2). Partial: yalnız enrollment'a bağlı (kampanya) aktiviteleri kapsar.
-- Additive-only; canlı tabloda güvenli.

CREATE INDEX IF NOT EXISTS idx_activities_enrollment
  ON activities(enrollment_id, campaign_step_order)
  WHERE enrollment_id IS NOT NULL;
