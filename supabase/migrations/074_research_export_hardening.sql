-- ==========================================
-- TG-Research v2 — Export hardening (codex batch-3 review: 1×P0 + parts of 2×P1 + 1×P2)
-- ------------------------------------------------------------------------------
--   P0  Suppressed companies were EXPORTABLE to the CRM: the route's match-verdict query never
--       filtered `suppressed`/the registry (suppression > dedup is a locked invariant — an erased
--       firm must never resurface in the customer's CRM). FIX: research_exportable_companies —
--       ONE suppression-safe read (rollup flag + registry anti-join) that also filters
--       already-exported rows BEFORE the limit (fixing the P1 where the batch re-read the same
--       top-200 forever and lower-scored matches were unreachable).
--
--   P1  (race half) A firm suppressed BETWEEN the read and the CRM insert could still be linked.
--       research_mark_exported now re-checks suppression UNDER the advisory lock and skips those,
--       and RETURNS the set of company_ids actually marked — the route compensates (deletes the
--       CRM rows it created for anything not marked) and alerts on count mismatches instead of
--       ignoring the RPC result.
--
--   P2  Period regex accepted invalid months (2026-00 / 2026-13), minting irreversible grant refs.
--       Tightened to (0[1-9]|1[0-2]).
--
-- Additive + re-runnable. SECURITY DEFINER, search_path pinned, service_role-only EXECUTE.
-- (research_mark_exported's return type changes → DROP first.)
-- ==========================================


-- ============================================================================
-- P0 + P1(batch) — suppression-safe, pagination-correct exportable read
-- ============================================================================
CREATE OR REPLACE FUNCTION research_exportable_companies(
  p_tenant  UUID,
  p_icp_id  UUID,
  p_ruleset INTEGER,
  p_limit   INTEGER DEFAULT 200
)
RETURNS TABLE (
  company_id   UUID,
  name         TEXT,
  domain       TEXT,
  website      TEXT,
  country      TEXT,
  city         TEXT,
  site_summary TEXT,
  score        INTEGER,
  evidence     TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.id, c.name, c.domain, c.website, c.country, c.city, c.site_summary,
         v.score, v.evidence
  FROM research_company_verdicts v
  JOIN research_companies c
    ON c.id = v.company_id AND c.tenant_id = v.tenant_id
  WHERE v.tenant_id = p_tenant
    AND v.icp_id = p_icp_id
    AND v.ruleset_version = p_ruleset
    AND v.verdict = 'match'
    AND c.crm_company_id IS NULL          -- unexported only — filtered BEFORE the limit
    AND c.suppressed = false              -- suppression > dedup (rollup flag)
    AND NOT EXISTS (                       -- …and the durable registry
      SELECT 1 FROM research_suppression s
      WHERE s.tenant_id = v.tenant_id AND s.entity_type = 'company'
        AND s.identity_key = c.canonical_key
    )
  ORDER BY v.score DESC NULLS LAST, v.created_at ASC, v.id ASC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);
$$;
REVOKE ALL ON FUNCTION research_exportable_companies(UUID, UUID, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_exportable_companies(UUID, UUID, INTEGER, INTEGER) TO service_role;


-- ============================================================================
-- P1(race) — mark_exported: suppression re-check under the lock + report WHAT was marked
-- ============================================================================
DROP FUNCTION IF EXISTS research_mark_exported(UUID, JSONB);

CREATE OR REPLACE FUNCTION research_mark_exported(
  p_tenant UUID,
  p_links  JSONB  -- [{"company_id":"…","crm_company_id":"…"}, …]
)
RETURNS SETOF UUID  -- the company_ids ACTUALLY marked; the caller compensates for the rest
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
  v_upd INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('research_bill:' || p_tenant::text));
  FOR r IN
    SELECT (e->>'company_id')::uuid AS company_id, (e->>'crm_company_id')::uuid AS crm_company_id
    FROM jsonb_array_elements(COALESCE(p_links, '[]'::jsonb)) AS t(e)
  LOOP
    -- A firm suppressed since the route's read must NOT be linked (suppression > dedup, no
    -- TOCTOU: this runs under the same lock research_suppress_company takes). Cross-tenant /
    -- unknown / already-linked rows are skipped the same way — the caller sees the delta.
    UPDATE research_companies c
      SET crm_company_id = r.crm_company_id,
          crm_exported_at = now(),
          updated_at = now()
      WHERE c.id = r.company_id AND c.tenant_id = p_tenant
        AND c.crm_company_id IS NULL
        AND c.suppressed = false
        AND NOT EXISTS (
          SELECT 1 FROM research_suppression s
          WHERE s.tenant_id = p_tenant AND s.entity_type = 'company'
            AND s.identity_key = c.canonical_key
        );
    GET DIAGNOSTICS v_upd = ROW_COUNT;
    IF v_upd > 0 THEN
      RETURN NEXT r.company_id;
    END IF;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION research_mark_exported(UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_mark_exported(UUID, JSONB) TO service_role;


-- ============================================================================
-- P2 — period grants: reject impossible months (2026-00 / 2026-13 minted refs forever)
-- Body otherwise identical to 073.
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
  IF p_period IS NULL OR p_period !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'research_apply_period_grants: invalid period % (expect YYYY-MM)', p_period;
  END IF;

  FOR r IN
    SELECT s.tenant_id, s.monthly_lead_quota
    FROM research_tenant_settings s
    WHERE s.auto_grant AND s.monthly_lead_quota > 0
      AND s.last_grant_period IS DISTINCT FROM p_period
    ORDER BY s.tenant_id
  LOOP
    IF pg_try_advisory_xact_lock(hashtext('research_bill:' || r.tenant_id::text)) THEN
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
