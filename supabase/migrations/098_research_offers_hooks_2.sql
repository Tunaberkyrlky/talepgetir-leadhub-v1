-- ==========================================
-- TG-Research v2 — WP4 hardening (codex verify P2)  [098]
--
-- research_exportable_companies returned v.angle_suggestion even when the offer behind the
-- code was later REJECTED (the approved-offer LEFT JOIN only nulled value_prop) — the CRM
-- handoff would carry a bare angle code the customer explicitly killed. The angle is now
-- gated on the join: no still-approved offer → angle_suggestion exports as NULL (and the
-- route's conditional custom_fields spread then omits 'Research Angle' entirely).
-- ==========================================

DROP FUNCTION IF EXISTS research_exportable_companies(UUID, UUID, INTEGER, INTEGER);

CREATE OR REPLACE FUNCTION research_exportable_companies(
  p_tenant UUID, p_icp_id UUID, p_ruleset INTEGER, p_limit INTEGER DEFAULT 200
)
RETURNS TABLE(
  company_id UUID, name TEXT, domain TEXT, website TEXT, country TEXT, city TEXT,
  site_summary TEXT, score INTEGER, evidence TEXT,
  icp_name TEXT, hooks JSONB, angle_suggestion TEXT, angle_value_prop TEXT
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.id, c.name, c.domain, c.website, c.country, c.city, c.site_summary,
         v.score, v.evidence,
         i.name AS icp_name, v.hooks,
         CASE WHEN o.value_prop IS NOT NULL THEN v.angle_suggestion ELSE NULL END AS angle_suggestion,
         o.value_prop AS angle_value_prop
  FROM research_company_verdicts v
  JOIN research_companies c
    ON c.id = v.company_id AND c.tenant_id = v.tenant_id
  JOIN research_icps i
    ON i.id = v.icp_id AND i.tenant_id = v.tenant_id
  LEFT JOIN research_offers o
    ON o.tenant_id = v.tenant_id AND o.icp_id = v.icp_id
   AND lower(o.angle_code) = lower(v.angle_suggestion) AND o.status = 'approved'
  WHERE v.tenant_id = p_tenant
    AND v.icp_id = p_icp_id
    AND v.ruleset_version = p_ruleset
    AND v.verdict = 'match'
    AND c.crm_company_id IS NULL
    AND c.suppressed = false
    AND NOT EXISTS (
      SELECT 1 FROM research_suppression s
      WHERE s.tenant_id = v.tenant_id AND s.entity_type = 'company'
        AND s.identity_key = c.canonical_key
    )
  ORDER BY v.score DESC NULLS LAST, v.created_at ASC, v.id ASC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);
$$;
REVOKE ALL ON FUNCTION research_exportable_companies(UUID, UUID, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_exportable_companies(UUID, UUID, INTEGER, INTEGER) TO service_role;
