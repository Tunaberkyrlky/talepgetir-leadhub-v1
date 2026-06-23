-- Faz 2 — Karar Ağacı: lineer kampanya dizisini GRAF'a çevirir.
-- Açık ileri-pointer'lar + node türü (step_kind) + config blob + giriş işareti.
-- Tümü nullable/defaultlı → mevcut lineer kampanyalar ve eski kayıt yolu (delete+reinsert)
-- bozulmaz; engine pointer yoksa step_order zincirine düşer (geriye-uyumlu fallback).
-- FK'ler DEFERRABLE: Batch 3'teki self-referential upsert (A→henüz-eklenmemiş B) için.

ALTER TABLE campaign_steps
    ADD COLUMN IF NOT EXISTS next_step_id UUID REFERENCES campaign_steps(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
    ADD COLUMN IF NOT EXISTS condition_true_step_id UUID REFERENCES campaign_steps(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
    ADD COLUMN IF NOT EXISTS condition_false_step_id UUID REFERENCES campaign_steps(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
    ADD COLUMN IF NOT EXISTS step_kind TEXT,            -- 'email'|'delay'|'condition'|'split'|'action'; NULL → step_type
    ADD COLUMN IF NOT EXISTS config JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS is_entry BOOLEAN NOT NULL DEFAULT false;

-- Kampanya başına en fazla bir giriş node'u.
CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_one_entry
    ON campaign_steps(campaign_id) WHERE is_entry;

-- Condition değerlendirme: bir enrollment'ın açılma/tıklama olayları
-- campaign_email_events.enrollment_id'de DEĞİL (tracking doldurmuyor) → activities
-- üzerinden join edilir. Bu index o sorguyu (enrollment + step) hızlandırır.
CREATE INDEX IF NOT EXISTS idx_activities_enrollment_step
    ON activities(enrollment_id, campaign_step_order)
    WHERE enrollment_id IS NOT NULL AND type = 'campaign_email';

-- Dal-bazlı analiz (branch_path gruplaması).
CREATE INDEX IF NOT EXISTS idx_enrollments_branch_path
    ON campaign_enrollments(campaign_id, branch_path);

-- Backfill — mevcut lineer kampanyaları graf-tutarlı yap (engine fallback yine var,
-- ama pointer'ları otoriter kılalım). Giriş = en küçük step_order; her node'un
-- next_step_id'si bir sonraki step_order; step_kind = step_type.
UPDATE campaign_steps s SET is_entry = true
    WHERE is_entry = false
      AND s.step_order = (SELECT MIN(s2.step_order) FROM campaign_steps s2 WHERE s2.campaign_id = s.campaign_id);

UPDATE campaign_steps s SET next_step_id = n.id
    FROM campaign_steps n
    WHERE s.next_step_id IS NULL
      AND n.campaign_id = s.campaign_id
      AND n.step_order = (SELECT MIN(s2.step_order) FROM campaign_steps s2
                          WHERE s2.campaign_id = s.campaign_id AND s2.step_order > s.step_order);

UPDATE campaign_steps SET step_kind = step_type WHERE step_kind IS NULL;
