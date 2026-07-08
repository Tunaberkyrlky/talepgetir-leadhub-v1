-- Cold Call itibar korumaları (plan §9): numara başına günlük arama tavanı.
-- Tavan tenant ayarıdır; yeni numaralarda warm-up eğrisi uygulama katmanında
-- bunun üzerine biner (effectiveDailyCap). Amaç: spam labeling'i tetikleyen
-- ani hacmi engellemek ve rotasyonu teşvik etmek.
ALTER TABLE coldcall_settings ADD COLUMN IF NOT EXISTS daily_cap_per_number INTEGER NOT NULL DEFAULT 100;

-- Numara bazlı gün içi sayım + 7 günlük sağlık istatistiği sorguları için
CREATE INDEX IF NOT EXISTS idx_coldcall_calls_number_started
  ON coldcall_calls(phone_number_id, started_at DESC);
