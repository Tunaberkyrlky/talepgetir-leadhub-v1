-- ==========================================
-- TG-Research v2 — Tier kotaları (Stripe'sız) + failed-run COGS + CRM export takibi
-- ------------------------------------------------------------------------------
-- Kullanıcı kararı: Stripe YOK. Kota yaşam döngüsü operatör + otomatik dönem grant'ı ile döner:
--
--   (a) research_tenant_settings — tenant başına research tier'ı + aylık lead kotası + reserve
--       boyutu + auto_grant bayrağı. CONFIG tablosudur (finansal state-machine değil): yazan
--       admin route'u (service_role); finansal chokepoint aşağıdaki RPC'dir. Müşteri kendi
--       satırını OKUYABİLİR (kota = adet, dolar değil).
--
--   (b) research_apply_period_grants(p_period) — dönemsel (aylık) kota grant'ı. Tenant başına
--       advisory TRY-lock (reaper kalıbı: meşgul tenant'ı atla, sonraki tick alır), ledger'a
--       DETERMİNİSTİK ref ile yazar (ref_id = md5('research_period_grant:'||tenant||':'||period)
--       ::uuid) → uq_research_usage_ledger_ref sayesinde dönem başına ÖMÜRDE BİR (çift grant
--       yapısal olarak imkânsız; RPC yeniden çalıştırılabilir, worker tick'i idempotent çağırır).
--
--   (c) Failed-run COGS artık kalıcı: runner, başarısız attempt'in kısmi meter tally'sini job
--       result'ına yazar (usage_raw + cost_recheck) — admin özeti failed_cost_usd kolonuyla
--       toplar (önceden sadece log'daydı; marj paneli başarısız harcamaya kördü). RETURNS TABLE
--       değişti → DROP + CREATE.
--
--   (d) CRM export takibi: research_companies.crm_company_id / crm_exported_at + fenced olmayan
--       ama SADECE export kolonlarına dokunan research_mark_exported RPC'si (route'tan çağrılır —
--       lease yok; billing/verdict/rollup state'ine DOKUNMAZ, bu yüzden lease fence gerekmez;
--       072 DML revoke'u nedeniyle RPC şart).
--
-- Additive + re-runnable. SECURITY DEFINER, search_path pinned, service_role-only EXECUTE.
-- ==========================================


-- ============================================================================
-- (a) research_tenant_settings — tier/kota konfigürasyonu
-- ============================================================================
CREATE TABLE IF NOT EXISTS research_tenant_settings (
  tenant_id          UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  research_tier      TEXT NOT NULL DEFAULT 'trial'
                     CHECK (research_tier IN ('trial','starter','growth','scale','custom')),
  -- Aylık otomatik grant (lead adedi). 0 = otomatik grant yok (yalnız manuel top-up).
  monthly_lead_quota INTEGER NOT NULL DEFAULT 0 CHECK (monthly_lead_quota >= 0),
  -- Run başına rezervasyon tavanı (null = tier default'u / env). Concurrency adaleti içindir.
  reserve_estimate   INTEGER CHECK (reserve_estimate IS NULL OR reserve_estimate >= 1),
  auto_grant         BOOLEAN NOT NULL DEFAULT true,
  -- Son uygulanan dönem ('YYYY-MM'). Ledger ref'i asıl idempotency guard'ıdır; bu, tarama filtresi.
  last_grant_period  TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE research_tenant_settings ENABLE ROW LEVEL SECURITY;
-- Müşteri kendi tier/kotasını görebilir (adetler — dolar yok); yazma yalnız service_role (admin route).
DROP POLICY IF EXISTS research_tenant_settings_select ON research_tenant_settings;
CREATE POLICY research_tenant_settings_select ON research_tenant_settings
  FOR SELECT USING (tenant_id = get_user_tenant_id());
REVOKE INSERT, UPDATE, DELETE ON research_tenant_settings FROM PUBLIC, anon, authenticated;


-- ============================================================================
-- (b) research_apply_period_grants — dönemsel kota grant'ı (idempotent, try-lock)
-- ============================================================================
CREATE OR REPLACE FUNCTION research_apply_period_grants(
  p_period TEXT DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM')
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count   INTEGER := 0;
  v_balance INTEGER;
  v_ref     UUID;
  v_ins     INTEGER;
  r         RECORD;
BEGIN
  IF p_period IS NULL OR p_period !~ '^\d{4}-\d{2}$' THEN
    RAISE EXCEPTION 'research_apply_period_grants: invalid period % (expect YYYY-MM)', p_period;
  END IF;

  FOR r IN
    SELECT s.tenant_id, s.monthly_lead_quota
    FROM research_tenant_settings s
    WHERE s.auto_grant AND s.monthly_lead_quota > 0
      AND s.last_grant_period IS DISTINCT FROM p_period
    ORDER BY s.tenant_id
  LOOP
    -- Meşgul tenant'ı ATLA (aktif reserve/bill/settle) — bloklamadan; sonraki tick yakalar.
    IF pg_try_advisory_xact_lock(hashtext('research_bill:' || r.tenant_id::text)) THEN
      -- Dönem başına ömürde-bir: deterministik ref, uq_research_usage_ledger_ref ile çarpışır.
      v_ref := md5('research_period_grant:' || r.tenant_id::text || ':' || p_period)::uuid;
      v_balance := COALESCE((SELECT sum(delta) FROM research_usage_ledger WHERE tenant_id = r.tenant_id), 0)
                   + r.monthly_lead_quota;
      INSERT INTO research_usage_ledger (tenant_id, delta, reason, ref_type, ref_id, balance_after)
      VALUES (r.tenant_id, r.monthly_lead_quota, 'period_grant', 'period_grant', v_ref, v_balance)
      ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS v_ins = ROW_COUNT;
      IF v_ins > 0 THEN
        v_count := v_count + 1;
      END IF;
      -- Grant zaten varsa da (yeniden koşum) dönemi işaretle — tarama filtresi sussun.
      UPDATE research_tenant_settings
        SET last_grant_period = p_period, updated_at = now()
        WHERE tenant_id = r.tenant_id;
    END IF;
  END LOOP;

  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION research_apply_period_grants(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_apply_period_grants(TEXT) TO service_role;


-- ============================================================================
-- (c) Admin özeti: failed_cost_usd — başarısız attempt'lerin kalıcılaşan kısmi COGS'u
-- ============================================================================
DROP FUNCTION IF EXISTS research_admin_cost_summary(TIMESTAMPTZ, TIMESTAMPTZ);

CREATE OR REPLACE FUNCTION research_admin_cost_summary(
  p_from TIMESTAMPTZ DEFAULT NULL,
  p_to   TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  tenant_id         UUID,
  tenant_name       TEXT,
  harvest_runs      BIGINT,
  failed_runs       BIGINT,
  harvest_cost_usd  NUMERIC,
  failed_cost_usd   NUMERIC,
  search_cost_usd   NUMERIC,
  icp_runs          BIGINT,
  icp_cost_usd      NUMERIC,
  billed_leads      BIGINT,
  credits_balance   BIGINT,
  credits_reserved  BIGINT,
  cost_per_lead_usd NUMERIC
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH active AS (
    SELECT DISTINCT tenant_id FROM research_jobs
    UNION SELECT DISTINCT tenant_id FROM research_usage_ledger
    UNION SELECT DISTINCT tenant_id FROM research_billable_events
    UNION SELECT DISTINCT tenant_id FROM research_projects
    UNION SELECT DISTINCT tenant_id FROM research_search_log
    UNION SELECT DISTINCT tenant_id FROM research_usage_holds
    UNION SELECT DISTINCT tenant_id FROM research_tenant_settings
  ),
  jobs AS (
    SELECT j.tenant_id,
           count(*) FILTER (WHERE j.type = 'harvest:run' AND j.status = 'succeeded') AS harvest_runs,
           count(*) FILTER (WHERE j.type = 'harvest:run' AND j.status = 'failed')    AS failed_runs,
           COALESCE(sum(
             CASE WHEN j.type = 'harvest:run' AND j.status = 'succeeded'
                  THEN NULLIF(j.result->'cost_usd'->>'totalUsd','')::numeric END
           ), 0)                                                                     AS harvest_cost_usd,
           -- Başarısız attempt'lerin kısmi COGS'u (LLM+grounding; runner failJob'a yazar).
           COALESCE(sum(
             CASE WHEN j.status = 'failed'
                  THEN NULLIF(j.result->'cost_recheck'->>'totalUsd','')::numeric END
           ), 0)                                                                     AS failed_cost_usd,
           count(*) FILTER (WHERE j.type = 'icp:generate' AND j.status = 'succeeded') AS icp_runs,
           COALESCE(sum(
             CASE WHEN j.type = 'icp:generate' AND j.status = 'succeeded'
                  THEN NULLIF(j.result->'cost_usd'->>'totalUsd','')::numeric END
           ), 0)                                                                     AS icp_cost_usd
    FROM research_jobs j
    WHERE (p_from IS NULL OR j.created_at >= p_from)
      AND (p_to   IS NULL OR j.created_at <  p_to)
    GROUP BY j.tenant_id
  ),
  search AS (
    SELECT s.tenant_id, COALESCE(sum(s.cost_usd), 0) AS search_cost_usd
    FROM research_search_log s
    WHERE (p_from IS NULL OR s.created_at >= p_from)
      AND (p_to   IS NULL OR s.created_at <  p_to)
    GROUP BY s.tenant_id
  ),
  billed AS (
    SELECT b.tenant_id, count(*) AS billed_leads
    FROM research_billable_events b
    WHERE (p_from IS NULL OR b.created_at >= p_from)
      AND (p_to   IS NULL OR b.created_at <  p_to)
    GROUP BY b.tenant_id
  ),
  ledger AS (
    SELECT l.tenant_id, COALESCE(sum(l.delta), 0)::bigint AS credits_balance
    FROM research_usage_ledger l
    GROUP BY l.tenant_id
  ),
  holds AS (
    SELECT h.tenant_id, COALESCE(sum(h.reserved - h.settled - h.released), 0)::bigint AS credits_reserved
    FROM research_usage_holds h
    WHERE h.status = 'open'
    GROUP BY h.tenant_id
  )
  SELECT
    a.tenant_id,
    t.name                                   AS tenant_name,
    COALESCE(j.harvest_runs, 0)              AS harvest_runs,
    COALESCE(j.failed_runs, 0)               AS failed_runs,
    COALESCE(j.harvest_cost_usd, 0)          AS harvest_cost_usd,
    COALESCE(j.failed_cost_usd, 0)           AS failed_cost_usd,
    COALESCE(s.search_cost_usd, 0)           AS search_cost_usd,
    COALESCE(j.icp_runs, 0)                  AS icp_runs,
    COALESCE(j.icp_cost_usd, 0)              AS icp_cost_usd,
    COALESCE(b.billed_leads, 0)              AS billed_leads,
    COALESCE(l.credits_balance, 0)           AS credits_balance,
    COALESCE(h.credits_reserved, 0)          AS credits_reserved,
    CASE WHEN COALESCE(b.billed_leads, 0) > 0
         THEN round(COALESCE(j.harvest_cost_usd, 0) / b.billed_leads, 6) END AS cost_per_lead_usd
  FROM active a
  LEFT JOIN tenants t  ON t.id = a.tenant_id
  LEFT JOIN jobs   j   ON j.tenant_id = a.tenant_id
  LEFT JOIN search s   ON s.tenant_id = a.tenant_id
  LEFT JOIN billed b   ON b.tenant_id = a.tenant_id
  LEFT JOIN ledger l   ON l.tenant_id = a.tenant_id
  LEFT JOIN holds  h   ON h.tenant_id = a.tenant_id
  ORDER BY COALESCE(j.harvest_cost_usd, 0) DESC, a.tenant_id;
$$;
REVOKE ALL ON FUNCTION research_admin_cost_summary(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_admin_cost_summary(TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;


-- ============================================================================
-- (d) CRM export takibi — kolonlar + dar-kapsamlı işaretleme RPC'si
-- ============================================================================
ALTER TABLE research_companies
  ADD COLUMN IF NOT EXISTS crm_company_id  UUID,
  ADD COLUMN IF NOT EXISTS crm_exported_at TIMESTAMPTZ;

-- Route'tan çağrılır (lease yok): yalnız export-takip kolonlarına dokunur — billing/verdict/rollup
-- durumu değişmez, bu yüzden lease fence gerekmez. Advisory kilit suppress/bill ile serileşme için.
-- Cross-tenant / bilinmeyen id'ler sessizce atlanır; güncellenen satır sayısı döner.
CREATE OR REPLACE FUNCTION research_mark_exported(
  p_tenant UUID,
  p_links  JSONB  -- [{"company_id":"…","crm_company_id":"…"}, …]
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER := 0;
  v_upd   INTEGER;
  r       RECORD;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('research_bill:' || p_tenant::text));
  FOR r IN
    SELECT (e->>'company_id')::uuid AS company_id, (e->>'crm_company_id')::uuid AS crm_company_id
    FROM jsonb_array_elements(COALESCE(p_links, '[]'::jsonb)) AS t(e)
  LOOP
    UPDATE research_companies
      SET crm_company_id = r.crm_company_id,
          crm_exported_at = now(),
          updated_at = now()
      WHERE id = r.company_id AND tenant_id = p_tenant AND crm_company_id IS NULL;
    GET DIAGNOSTICS v_upd = ROW_COUNT;
    v_count := v_count + v_upd;
  END LOOP;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION research_mark_exported(UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_mark_exported(UUID, JSONB) TO service_role;
