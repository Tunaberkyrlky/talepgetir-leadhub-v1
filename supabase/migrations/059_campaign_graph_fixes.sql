-- ============================================================================
-- 059: Faz 2 graf düzeltmeleri (code-review bulguları)
-- 1) Graf kaydı prune'unda FK ihlalini önle.
-- 2) reply-condition node'larının değerlendirilebilmesi için kalıcı yanıt işareti.
-- ============================================================================

-- ── Bulgu 1: prune (save_campaign_graph) FK ihlali ──────────────────────────
-- save_campaign_graph payload'da olmayan node'ları siliyor. Ancak
-- campaign_enrollments.current_step_id FK'sinin ON DELETE eylemi yoktu (NO ACTION)
-- ve completeEnrollment / reply iptali current_step_id'i null'lamıyor. Bu yüzden
-- terminal (completed/replied/bounced) bir enrollment'ın işaret ettiği bir node
-- prune edilince DELETE FK ihlaliyle (23503) patlıyor → RPC tüm transaction'ı
-- geri alıyor, kullanıcı grafı kaydedemiyor. Aktif/duraklı enrollment'lar route
-- guard'ında (campaigns.ts) zaten 422 ile korunuyor; bu FK yalnız terminal
-- enrollment'ların pointer'ını güvenle null'lar.
ALTER TABLE campaign_enrollments
    DROP CONSTRAINT IF EXISTS campaign_enrollments_current_step_id_fkey;
ALTER TABLE campaign_enrollments
    ADD CONSTRAINT campaign_enrollments_current_step_id_fkey
    FOREIGN KEY (current_step_id) REFERENCES campaign_steps(id) ON DELETE SET NULL;

-- ── Bulgu 2: reply-condition'lar için kalıcı yanıt işareti ──────────────────
-- 'replied'/'not_replied' condition'ları eskiden enrollment.status'tan okunuyordu.
-- Ama yanıt gelince cancelEnrollmentOnReply status'u 'replied' yapıp
-- next_scheduled_at'i null'lıyor → enrollment scheduler havuzundan (status='active')
-- çıkıyor → oturduğu condition node'u hiç işlenmiyor. Sonuç: 'replied' dalı asla
-- alınamıyor, 'not_replied' hep true dönüyor. Çözüm: yanıt anını kalıcı olarak
-- replied_at'e yaz; condition bunu okusun. cancelEnrollmentOnReply ayrıca
-- reply-condition'ı olan kampanyalardaki enrollment'ı sonlandırmaz (condition'a
-- ulaşsın diye); diğerlerinde eski iptal davranışı aynen korunur.
ALTER TABLE campaign_enrollments
    ADD COLUMN IF NOT EXISTS replied_at TIMESTAMPTZ;
