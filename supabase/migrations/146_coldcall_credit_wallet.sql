-- ==========================================
-- Cold Call — ön-ödemeli dakika CÜZDANI (rollover) + append-only kredi ledger'ı.
-- Plan: plans/COLD_CALL_CREDIT_PLAN.md §3.
--
-- NOT (renumber): plan bu dosyayı "143_coldcall_credit_wallet.sql" olarak
-- adlandırmıştı, ancak 143/144/145 numaraları o sırada başka (research/linkedin)
-- migration'lar tarafından alınmıştı. Uygulama Supabase'de dosya-numarasına değil
-- timestamp version'a göre izlendiğinden bu kozmetik bir çakışma olurdu ama
-- karışıklığı önlemek için 146 kullanılıyor (CLAUDE.md migration kuralı).
--
-- Model: minutes_balance TEK gerçek sayaç — admin yükler, çağrı düşer, AY BAŞINDA
-- SIFIRLANMAZ (devreder). minutes_quota/minutes_used/period_start VESTIGIAL kalır
-- (destructive drop yok) — kod artık okumaz/yazmaz (server/src/coldcall/lib/settings.ts).
-- ==========================================

-- 3.1 Cüzdan bakiyesi (coldcall_settings üzerinde, tek-satır atomik update deseni)
ALTER TABLE coldcall_settings
  ADD COLUMN minutes_balance NUMERIC(12,2) NOT NULL DEFAULT 0;

-- Mevcut tenant'lar erişimi kaybetmesin: kalan kotayı bakiyeye taşı (idempotent seed —
-- WHERE minutes_balance = 0 guard'ı, kolon taze ADD COLUMN'dan geldiği için tek seferlik
-- güvenli backfill; izole test DB için makul, prod'da coldcall zaten temiz).
UPDATE coldcall_settings
  SET minutes_balance = GREATEST(minutes_quota - minutes_used, 0)
  WHERE minutes_balance = 0;
-- NOT: backfill edilen bakiyeler için 'initial' ledger seed satırı, ledger tablosu
-- yaratıldıktan SONRA aşağıda (3.2 sonrası) eklenir.

-- 3.2 Ledger — append-only, dakika-only, $ YOK (müşteriye güvenle gösterilebilir)
CREATE TABLE coldcall_credit_ledger (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  delta_minutes   NUMERIC(12,2) NOT NULL,   -- işaretli: + grant/refund/initial, - usage/aşağı-düzeltme
  kind            TEXT NOT NULL CHECK (kind IN ('grant','usage','adjustment','refund','initial')),
  balance_after   NUMERIC(12,2) NOT NULL,
  reason          TEXT,                      -- admin notu / "fatura #123" / sistem
  call_id         UUID REFERENCES coldcall_calls(id) ON DELETE SET NULL,  -- yalnız usage satırları
  created_by      UUID REFERENCES auth.users(id),   -- yükleyen admin (usage'da NULL)
  source          TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','stripe','system')), -- stripe-ready
  idempotency_key TEXT,                      -- grant tekrarını (çift-tık/retry) engeller
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_coldcall_ledger_tenant ON coldcall_credit_ledger(tenant_id, created_at DESC);
-- Grant idempotency: aynı key iki kez uygulanmaz
CREATE UNIQUE INDEX idx_coldcall_ledger_idem ON coldcall_credit_ledger(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
-- Usage idempotency: çağrı başına EN FAZLA bir 'usage' düşümü (webhook retry güvenli)
CREATE UNIQUE INDEX idx_coldcall_ledger_call_usage ON coldcall_credit_ledger(call_id)
  WHERE kind = 'usage';

-- Backfill edilen her bakiye için bir 'initial' ledger satırı (codex P2) — yoksa ledger
-- toplamı ile minutes_balance uyuşmaz (mutabakat kırılır). Bakiyeyi ledger'a bağlar;
-- sonraki hareketler bunun üstüne devam eder. (idempotency_key/call_id NULL → çakışma yok.)
INSERT INTO coldcall_credit_ledger(tenant_id, delta_minutes, kind, balance_after, reason, source)
  SELECT tenant_id, minutes_balance, 'initial', minutes_balance,
         'Kota→cüzdan geçişi (devreden bakiye)', 'system'
  FROM coldcall_settings
  WHERE minutes_balance > 0;

-- RLS: deny-all (policy yok) — coldcall_* tablolarının hepsinde olduğu gibi tüm
-- erişim service-role üzerinden, alan bazlı filtre server'da (fail-closed, 079 deseni).
ALTER TABLE coldcall_credit_ledger ENABLE ROW LEVEL SECURITY;

-- 3.2b Tek in-flight çağrı (codex P1): tenant başına EN FAZLA bir terminal-olmayan çağrı.
-- Eşzamanlı POST'larda bakiye aşımını ATOMİK sınırlar (app-seviyesi count-then-insert
-- TOCTOU'ya açıktı; INSERT artık 23505 ile reddedilir → calls.ts 409'a çevirir). Önce mevcut
-- takılı/çoklu terminal-olmayan satırları temizle (yoksa unique index yaratımı çakışır —
-- izole test DB'de eski smoke satırları olabilir; deploy anında uçuşta çağrı olmaz).
UPDATE coldcall_calls SET status = 'failed', ended_at = COALESCE(ended_at, now())
  WHERE status NOT IN ('completed','busy','no_answer','failed','canceled');
CREATE UNIQUE INDEX idx_coldcall_calls_one_active ON coldcall_calls(tenant_id)
  WHERE status NOT IN ('completed','busy','no_answer','failed','canceled');

-- 3.3 RPC — atomik grant (idempotent, TOCTOU-safe). Sıralama: önce ledger satırını
-- UNIQUE ile claim et (idempotency), sonra bakiyeyi güncelle, sonra balance_after'ı yaz.
-- Hepsi tek fonksiyon → tek transaction.
CREATE OR REPLACE FUNCTION coldcall_grant_minutes(
  p_tenant_id UUID, p_minutes NUMERIC, p_kind TEXT, p_reason TEXT,
  p_created_by UUID, p_source TEXT, p_idempotency_key TEXT
) RETURNS NUMERIC LANGUAGE plpgsql AS $$
DECLARE v_ledger_id UUID; v_new NUMERIC;
BEGIN
  -- Tenant ayar satırını kilitle (codex P2): eşzamanlı grant/deduct'lar serileşir →
  -- balance_after her zaman created_at ile aynı sırada; ledger tutarlı kalır.
  PERFORM 1 FROM coldcall_settings WHERE tenant_id = p_tenant_id FOR UPDATE;
  INSERT INTO coldcall_credit_ledger(tenant_id, delta_minutes, kind, balance_after,
                                     reason, created_by, source, idempotency_key)
    VALUES (p_tenant_id, p_minutes, p_kind, 0, p_reason, p_created_by, p_source, p_idempotency_key)
    ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
    RETURNING id INTO v_ledger_id;
  IF v_ledger_id IS NULL THEN                         -- duplicate key → no-op, mevcut bakiyeyi dön
    SELECT minutes_balance INTO v_new FROM coldcall_settings WHERE tenant_id = p_tenant_id;
    RETURN v_new;
  END IF;
  UPDATE coldcall_settings SET minutes_balance = minutes_balance + p_minutes, updated_at = now()
    WHERE tenant_id = p_tenant_id RETURNING minutes_balance INTO v_new;
  IF NOT FOUND THEN RAISE EXCEPTION 'coldcall_settings row missing for %', p_tenant_id; END IF;
  UPDATE coldcall_credit_ledger SET balance_after = v_new WHERE id = v_ledger_id;
  RETURN v_new;
END; $$;

-- 3.4 RPC — atomik deduct (çağrı başına idempotent). coldcall_add_used_minutes (082)
-- yerine geçer; 082'yi KALDIRMIYORUZ (finalize.ts bu yeni RPC'ye repoint edildi,
-- eski fonksiyon DB'de dokunulmadan durur — geriye dönük uyumluluk, destructive değil).
CREATE OR REPLACE FUNCTION coldcall_deduct_minutes(
  p_tenant_id UUID, p_minutes NUMERIC, p_call_id UUID, p_reason TEXT
) RETURNS NUMERIC LANGUAGE plpgsql AS $$
DECLARE v_ledger_id UUID; v_new NUMERIC;
BEGIN
  -- Tenant ayar satırını kilitle (codex P2): eşzamanlı deduct/grant'lar serileşir.
  PERFORM 1 FROM coldcall_settings WHERE tenant_id = p_tenant_id FOR UPDATE;
  INSERT INTO coldcall_credit_ledger(tenant_id, delta_minutes, kind, balance_after, call_id, source, reason)
    VALUES (p_tenant_id, -p_minutes, 'usage', 0, p_call_id, 'system', p_reason)
    ON CONFLICT (call_id) WHERE kind = 'usage' DO NOTHING     -- çift finalize → tek düşüm
    RETURNING id INTO v_ledger_id;
  IF v_ledger_id IS NULL THEN                                 -- zaten düşülmüş
    SELECT minutes_balance INTO v_new FROM coldcall_settings WHERE tenant_id = p_tenant_id;
    RETURN v_new;
  END IF;
  UPDATE coldcall_settings SET minutes_balance = minutes_balance - p_minutes, updated_at = now()
    WHERE tenant_id = p_tenant_id RETURNING minutes_balance INTO v_new;   -- eksiye düşebilir (kabul, plan §8.1)
  UPDATE coldcall_credit_ledger SET balance_after = v_new WHERE id = v_ledger_id;
  RETURN v_new;
END; $$;

-- 3.5 "Bu ay kullanılan" toplamı — DB tarafı aggregate (codex P2: JS'te satır çekip
-- reduce etmek PostgREST satır limitinde toplamı eksik veriyordu). Sadece usage, ay başından.
CREATE OR REPLACE FUNCTION coldcall_used_this_period(p_tenant_id UUID)
RETURNS NUMERIC LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(-delta_minutes), 0)::NUMERIC
  FROM coldcall_credit_ledger
  WHERE tenant_id = p_tenant_id AND kind = 'usage'
    AND created_at >= date_trunc('month', now());
$$;

-- 3.6 Faturalanıp henüz kredi düşülmemiş çağrılar (codex P1): finalize terminal UPDATE'i
-- geçip deductMinutes RPC'si hata verirse çağrı 'completed' + billed_minutes>0 kalır ama
-- usage ledger satırı oluşmaz → bakiye düşmez. Bu fonksiyon o çağrıları listeler; server
-- (sweepStaleCalls) her biri için deductMinutes'i tekrar çağırır (call_id idempotent → güvenli).
CREATE OR REPLACE FUNCTION coldcall_pending_usage_calls(p_tenant_id UUID)
RETURNS TABLE(call_id UUID, billed_minutes NUMERIC) LANGUAGE sql STABLE AS $$
  SELECT c.id, c.billed_minutes
  FROM coldcall_calls c
  WHERE c.tenant_id = p_tenant_id
    AND c.status = 'completed'
    AND COALESCE(c.billed_minutes, 0) > 0
    AND c.created_at > now() - interval '30 days'   -- yeterince geniş pencere (codex: 2 gün dardı)
    AND NOT EXISTS (
      SELECT 1 FROM coldcall_credit_ledger l
      WHERE l.call_id = c.id AND l.kind = 'usage'
    );
$$;

-- Her iki RPC yalnız service-role çağırır (020/082 deseniyle tutarlı).
REVOKE EXECUTE ON FUNCTION coldcall_grant_minutes(UUID,NUMERIC,TEXT,TEXT,UUID,TEXT,TEXT)  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION coldcall_deduct_minutes(UUID,NUMERIC,UUID,TEXT)                FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION coldcall_used_this_period(UUID)                                FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION coldcall_pending_usage_calls(UUID)                             FROM PUBLIC, anon, authenticated;

-- service_role'e açık GRANT (codex P2: secure-default projelerde deterministik olsun; server
-- supabaseAdmin = service_role ile çağırır). 082 deseni service_role'ün default EXECUTE'una
-- güveniyordu; burada açıkça veriyoruz.
GRANT EXECUTE ON FUNCTION coldcall_grant_minutes(UUID,NUMERIC,TEXT,TEXT,UUID,TEXT,TEXT)   TO service_role;
GRANT EXECUTE ON FUNCTION coldcall_deduct_minutes(UUID,NUMERIC,UUID,TEXT)                 TO service_role;
GRANT EXECUTE ON FUNCTION coldcall_used_this_period(UUID)                                 TO service_role;
GRANT EXECUTE ON FUNCTION coldcall_pending_usage_calls(UUID)                              TO service_role;
