-- 071: Grafta per-node kolon eşleme için kampanyada CSV kaynağını sakla.
-- { file_id, file_name, headers[], columns:{email,company,website,location,industry,email_status,dnc_status}, row_count, uploaded_at }
-- file_id → import_file_cache (2 saat TTL). Her email adımının mesaj/konu kolonu
-- step.config.csv_body_col / csv_subject_col'da tutulur (steps ile kalıcı).
-- Additive-only; canlı tabloda güvenli.

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS csv_source JSONB;
