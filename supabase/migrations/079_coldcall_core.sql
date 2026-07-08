-- ==========================================
-- Cold Call module — core tables (isolated namespace: coldcall_*)
--
-- Design (plans/COLD_CALL_PLAN.md):
--   * Tenant başına telefoni ayarları + dakika kotası (idempotent period reset).
--   * Numaralar, çağrılar, kayıtlar, transkriptler — hepsi tenant-scoped.
--   * COGS alanları (cogs_usd, monthly_cost_usd) MÜŞTERİYE ASLA gösterilmez;
--     API katmanı role göre shape'ler. Bu yüzden RLS: deny-all (policy yok) —
--     tüm erişim service-role üzerinden, alan bazlı filtre server'da (fail-closed).
--   * activities entegrasyonu: disposition → activities(type='call') satırı,
--     coldcall_calls.activity_id ile bağlanır. activities şeması DEĞİŞMEZ.
-- ==========================================

CREATE TABLE coldcall_settings (
  tenant_id           UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  provider            TEXT NOT NULL DEFAULT 'mock' CHECK (provider IN ('mock','twilio')),
  subaccount_sid      TEXT,
  api_key_sid         TEXT,
  api_key_secret_enc  TEXT,            -- AES-256-GCM blob (lib/encryption.ts)
  recording_mode      TEXT NOT NULL DEFAULT 'announce' CHECK (recording_mode IN ('always','announce','off')),
  default_phone_number_id UUID,        -- FK eklenmiyor (döngüsel); uygulama doğrular
  minutes_quota       INTEGER NOT NULL DEFAULT 300,
  minutes_used        NUMERIC(10,2) NOT NULL DEFAULT 0,
  period_start        DATE NOT NULL DEFAULT date_trunc('month', now())::date,
  max_numbers         INTEGER NOT NULL DEFAULT 5,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE coldcall_phone_numbers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL DEFAULT 'mock',
  provider_sid      TEXT,
  e164              TEXT NOT NULL,
  country_code      TEXT NOT NULL,     -- ISO-3166 alpha-2 ('US','GB',…)
  friendly_name     TEXT,
  capabilities      JSONB NOT NULL DEFAULT '{"voice": true}',
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending_regulatory','active','released')),
  monthly_cost_usd  NUMERIC(8,2),      -- COGS: yalnız internal roller görür
  purchased_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at       TIMESTAMPTZ,
  created_by        UUID REFERENCES auth.users(id),
  UNIQUE (tenant_id, e164)
);

CREATE INDEX idx_coldcall_numbers_tenant ON coldcall_phone_numbers(tenant_id) WHERE status <> 'released';

CREATE TABLE coldcall_calls (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id         UUID REFERENCES companies(id) ON DELETE SET NULL,
  contact_id         UUID,
  user_id            UUID REFERENCES auth.users(id),
  phone_number_id    UUID REFERENCES coldcall_phone_numbers(id),
  direction          TEXT NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound','inbound')),
  from_e164          TEXT NOT NULL,
  to_e164            TEXT NOT NULL,
  to_country         TEXT,             -- ISO alpha-2, tarife/çarpan buradan
  provider_call_sid  TEXT UNIQUE,
  status             TEXT NOT NULL DEFAULT 'queued' CHECK (status IN
                       ('queued','ringing','in_progress','completed','busy','no_answer','failed','canceled')),
  started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  answered_at        TIMESTAMPTZ,
  ended_at           TIMESTAMPTZ,
  duration_sec       INTEGER,
  rate_multiplier    NUMERIC(4,1) NOT NULL DEFAULT 1,   -- pahalı ülke = dakika çarpanı
  billed_minutes     NUMERIC(10,2),                     -- ceil(duration/60) * multiplier
  cogs_usd           NUMERIC(10,4),   -- COGS: müşteri ASLA görmez (API shape'ler)
  disposition        TEXT CHECK (disposition IN
                       ('connected','interested','not_interested','callback','voicemail','no_answer','busy','wrong_number')),
  notes              TEXT,
  activity_id        UUID REFERENCES activities(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_coldcall_calls_tenant ON coldcall_calls(tenant_id, created_at DESC);
CREATE INDEX idx_coldcall_calls_company ON coldcall_calls(company_id) WHERE company_id IS NOT NULL;

CREATE TABLE coldcall_recordings (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id                UUID NOT NULL REFERENCES coldcall_calls(id) ON DELETE CASCADE,
  tenant_id              UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider_recording_sid TEXT,
  storage_path           TEXT,          -- coldcall-recordings/{tenant_id}/{call_id}.wav
  duration_sec           INTEGER,
  channels               INTEGER NOT NULL DEFAULT 2,
  status                 TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','stored','failed','deleted')),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_coldcall_recordings_call ON coldcall_recordings(call_id);

CREATE TABLE coldcall_transcripts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id       UUID NOT NULL UNIQUE REFERENCES coldcall_calls(id) ON DELETE CASCADE,
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  recording_id  UUID REFERENCES coldcall_recordings(id) ON DELETE SET NULL,
  provider      TEXT,                  -- 'mock' | 'deepgram' | 'whisper'
  language      TEXT,
  segments      JSONB,                 -- [{speaker:'agent'|'lead', start_sec, end_sec, text}]
  full_text     TEXT,
  summary       TEXT,                  -- AI özeti (reading-rolü LLM)
  action_items  JSONB,                 -- ["…", …]
  sentiment     TEXT CHECK (sentiment IN ('positive','neutral','negative')),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS: deny-all. Tüm okuma/yazma server API üzerinden (service role) yapılır;
-- COGS alanları tablo seviyesinde policy ile korunamayacağı için client'a
-- doğrudan Supabase erişimi bilinçli olarak kapalıdır.
ALTER TABLE coldcall_settings      ENABLE ROW LEVEL SECURITY;
ALTER TABLE coldcall_phone_numbers ENABLE ROW LEVEL SECURITY;
ALTER TABLE coldcall_calls         ENABLE ROW LEVEL SECURITY;
ALTER TABLE coldcall_recordings    ENABLE ROW LEVEL SECURITY;
ALTER TABLE coldcall_transcripts   ENABLE ROW LEVEL SECURITY;

-- Kayıt sesleri için private bucket (oynatma kısa ömürlü signed URL ile).
INSERT INTO storage.buckets (id, name, public)
VALUES ('coldcall-recordings', 'coldcall-recordings', false)
ON CONFLICT (id) DO NOTHING;
