-- ============================================================================
-- 042: Email Connections — Multi-account + SMTP/IMAP support
--
-- Bir tenant artık BİRDEN FAZLA mail hesabı bağlayabilir (Workspace + SMTP
-- karışık). SMTP/IMAP hesapları credential ile (host/port/user/şifre) bağlanır;
-- şifre AES-256-GCM ile şifrelenmiş tutulur (encrypted_password).
-- ============================================================================

-- Tek-bağlantı kısıtını kaldır → tenant başına birden fazla hesap
ALTER TABLE email_connections DROP CONSTRAINT email_connections_tenant_id_key;
ALTER TABLE email_connections
  ADD CONSTRAINT uq_conn_tenant_email UNIQUE (tenant_id, email_address);

-- provider'a 'smtp' ekle
ALTER TABLE email_connections DROP CONSTRAINT email_connections_provider_check;
ALTER TABLE email_connections
  ADD CONSTRAINT email_connections_provider_check
  CHECK (provider IN ('google-mail', 'microsoft-outlook', 'smtp'));

-- SMTP'de Nango connection_id yok
ALTER TABLE email_connections ALTER COLUMN connection_id DROP NOT NULL;

-- Yeni kolonlar
ALTER TABLE email_connections
  ADD COLUMN is_default         BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN smtp_host          TEXT,
  ADD COLUMN smtp_port          INT,
  ADD COLUMN smtp_secure        BOOLEAN,
  ADD COLUMN imap_host          TEXT,
  ADD COLUMN imap_port          INT,
  ADD COLUMN imap_secure        BOOLEAN,
  ADD COLUMN username           TEXT,
  ADD COLUMN encrypted_password TEXT,
  ADD COLUMN allow_invalid_cert BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN last_polled_at     TIMESTAMPTZ,
  ADD COLUMN last_seen_uid      BIGINT,
  ADD COLUMN last_uid_validity  BIGINT;

-- Tenant başına tek default gönderim hesabı
CREATE UNIQUE INDEX uq_conn_one_default
  ON email_connections (tenant_id)
  WHERE is_default;

-- Mevcut tek bağlantısı olan tenant'ları default yap (geri uyum)
UPDATE email_connections SET is_default = true
WHERE id IN (
  SELECT DISTINCT ON (tenant_id) id
  FROM email_connections
  WHERE is_active = true
  ORDER BY tenant_id, connected_at ASC
);
