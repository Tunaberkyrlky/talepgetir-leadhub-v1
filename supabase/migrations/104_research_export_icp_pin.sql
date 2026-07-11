-- ==========================================
-- TG-Research v2 — Export-moment ICP/geo pinning (WP5 attribution correctness)
-- ------------------------------------------------------------------------------
-- Closes the P3 documented in 04_ILERLEME.md §4.13 / feedbackAggregate.ts: campaign outcomes
-- were attributed to the company's CURRENT rollup (icp_id, geo_id). A firm re-discovered under
-- another ICP/geo AFTER export then reported its outcomes against the WRONG cell (and the
-- upsert+prune recompute would migrate the whole cell), skewing response-rate stats and the
-- icp:revise evidence.
--
-- FIX: pin the (ICP, geo) the batch was exported UNDER, at export time, on research_companies.
--   • crm_exported_icp_id — the export request's ICP (the ICP whose copy the campaign runs).
--   • crm_exported_geo_id — the row's rollup geo AT export (snapshot; may be NULL for Y3/free-text
--                           harvests that never set geo — same as today, just frozen).
-- Written ONLY on the first export (the crm_company_id IS NULL guard already gates the UPDATE),
-- so a re-export can never rewrite the attribution the outcomes were already measured against.
-- Legacy rows (exported before this migration) keep NULL pins → feedback:aggregate falls back to
-- the current rollup, exactly its prior behavior. Angle stays DERIVED from the pinned ICP's
-- current-ruleset verdict in the handler (no angle column needed — the derivation already exists).
--
-- research_mark_exported gains p_icp_id (DEFAULT NULL keeps a 2-arg call valid). It stays a
-- narrow export-tracking RPC: no billing/verdict/rollup state touched, so no lease fence (the
-- advisory lock still serializes it against suppress/bill). Signature grows → DROP the old
-- 2-arg overload first so a 2-arg call can't turn ambiguous. Additive + re-runnable.
-- SECURITY DEFINER, search_path pinned, service_role-only EXECUTE.
-- ==========================================

ALTER TABLE research_companies
  ADD COLUMN IF NOT EXISTS crm_exported_icp_id UUID,
  ADD COLUMN IF NOT EXISTS crm_exported_geo_id UUID;

-- FK ON DELETE SET NULL (codex P2): the pins are copied into research_outcome_stats.icp_id/geo_id,
-- which are FK-backed (ON DELETE CASCADE). Without these constraints, deleting an ICP/geo (a normal
-- route — project delete cascades ICP/geo while the exported research_companies row survives with its
-- rollup nulled) would leave a DANGLING pin; the next feedback:aggregate would build a cell from the
-- dead UUID and the outcome-stats upsert would FK-violate and fail the whole job. SET NULL drops the
-- pin so attribution falls back to the current rollup — exactly the legacy (pre-pin) path. Guarded so
-- the migration stays re-runnable; the columns are freshly added (all NULL) so validation is trivial.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'research_companies_crm_exported_icp_id_fkey') THEN
    ALTER TABLE research_companies
      ADD CONSTRAINT research_companies_crm_exported_icp_id_fkey
      FOREIGN KEY (crm_exported_icp_id) REFERENCES research_icps(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'research_companies_crm_exported_geo_id_fkey') THEN
    ALTER TABLE research_companies
      ADD CONSTRAINT research_companies_crm_exported_geo_id_fkey
      FOREIGN KEY (crm_exported_geo_id) REFERENCES research_geographies(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Index the FK columns so an ICP/geo delete (the SET NULL cascade above) doesn't seq-scan
-- research_companies (codex verify note). PARTIAL — the columns are NULL for every non-exported row.
CREATE INDEX IF NOT EXISTS idx_research_companies_crm_exported_icp
  ON research_companies (crm_exported_icp_id) WHERE crm_exported_icp_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_research_companies_crm_exported_geo
  ON research_companies (crm_exported_geo_id) WHERE crm_exported_geo_id IS NOT NULL;

DROP FUNCTION IF EXISTS research_mark_exported(UUID, JSONB);

CREATE OR REPLACE FUNCTION research_mark_exported(
  p_tenant UUID,
  p_links  JSONB,  -- [{"company_id":"…","crm_company_id":"…"}, …]
  p_icp_id UUID DEFAULT NULL  -- the ICP this batch was exported UNDER (pinned for WP5 attribution)
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
    -- crm_exported_geo_id = c.geo_id snapshots the row's PRE-update rollup geo (SET reads OLD).
    UPDATE research_companies c
      SET crm_company_id = r.crm_company_id,
          crm_exported_at = now(),
          crm_exported_icp_id = p_icp_id,
          crm_exported_geo_id = c.geo_id,
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
REVOKE ALL ON FUNCTION research_mark_exported(UUID, JSONB, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_mark_exported(UUID, JSONB, UUID) TO service_role;
