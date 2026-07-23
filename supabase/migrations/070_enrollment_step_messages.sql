-- 070: Follow-up zinciri için per-alıcı, per-adım hazır mesaj saklama.
-- { "<campaign_steps.id>": { "subject": "...", "body": "..." }, ... }
-- Anahtar = step_id (step_order DEĞİL) → adım reorder'ına dayanıklı; adım silinirse
-- o mesaj orphan olur, motor şablona düşer (güvenli fallback).
-- Geriye uyum: mevcut tek-intro CSV kampanyaları intro'yu custom_body_text/subject'te
-- tutmaya devam eder; motor önce step_messages'a, yoksa entry adımı için eski kolonlara bakar.
-- Additive-only; canlı tabloda güvenli.

ALTER TABLE campaign_enrollments
  ADD COLUMN IF NOT EXISTS step_messages JSONB;
