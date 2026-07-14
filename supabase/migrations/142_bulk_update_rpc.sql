-- Bulk edit — per-company atomic apply RPC  [142]  (v2 Phase 8, E10)
--
-- POST /companies/bulk-update applies a field patch + tag links/unlinks to up to
-- 200 companies with per-company isolation. Sequential PostgREST statements can
-- leave a company HALF-applied (tags added, field update failed) while its result
-- reports ok:false. This function is the fix: ONE call = ONE transaction per
-- company — any failure rolls back that company's tag AND field changes together.
--
-- Depends on 139_qualification (companies.priority/lead_source/qualification_status,
-- tags, company_tags). The route falls back to the legacy sequential path when this
-- function is missing (PGRST202/42883), so deploy order cannot break bulk edit.
--
-- Posture (135/141): SECURITY DEFINER + explicit p_tenant_id (server passes the
-- auth-resolved tenant), REVOKE PUBLIC/anon/authenticated + GRANT service_role.
-- RAISEd messages are stable machine codes the route maps to per-company reasons.
CREATE OR REPLACE FUNCTION crm_bulk_update_company(
  p_tenant_id   UUID,
  p_company_id  UUID,
  p_user_id     UUID,
  p_fields      JSONB   DEFAULT '{}'::jsonb,
  p_tags_add    UUID[]  DEFAULT NULL,
  p_tags_remove UUID[]  DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bad UUID;
BEGIN
  -- Company must live in the tenant; FOR UPDATE serialises concurrent bulk ops
  -- against the same row so interleaved patches can't half-mix.
  PERFORM 1 FROM companies
    WHERE id = p_company_id AND tenant_id = p_tenant_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  -- Tag links. Every tag must belong to the tenant (the company_tags fence from
  -- 139 is the second layer); ON CONFLICT keeps re-links idempotent.
  IF p_tags_add IS NOT NULL AND array_length(p_tags_add, 1) > 0 THEN
    SELECT t.tid INTO v_bad
      FROM unnest(p_tags_add) AS t(tid)
     WHERE NOT EXISTS (SELECT 1 FROM tags WHERE id = t.tid AND tenant_id = p_tenant_id)
     LIMIT 1;
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'foreign_tag';
    END IF;
    INSERT INTO company_tags (tenant_id, company_id, tag_id, created_by)
    SELECT p_tenant_id, p_company_id, t.tid, p_user_id
      FROM unnest(p_tags_add) AS t(tid)
    ON CONFLICT (company_id, tag_id) DO NOTHING;
  END IF;

  IF p_tags_remove IS NOT NULL AND array_length(p_tags_remove, 1) > 0 THEN
    DELETE FROM company_tags
     WHERE tenant_id = p_tenant_id
       AND company_id = p_company_id
       AND tag_id = ANY (p_tags_remove);
  END IF;

  -- Whitelisted field patch (139 CHECKs + route Zod validate the values). A JSON
  -- null for lead_source clears the column (->> yields SQL NULL).
  IF p_fields ? 'priority' THEN
    UPDATE companies SET priority = p_fields->>'priority', updated_at = now()
     WHERE id = p_company_id AND tenant_id = p_tenant_id;
  END IF;
  IF p_fields ? 'qualification_status' THEN
    UPDATE companies SET qualification_status = p_fields->>'qualification_status', updated_at = now()
     WHERE id = p_company_id AND tenant_id = p_tenant_id;
  END IF;
  IF p_fields ? 'lead_source' THEN
    UPDATE companies SET lead_source = p_fields->>'lead_source', updated_at = now()
     WHERE id = p_company_id AND tenant_id = p_tenant_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION crm_bulk_update_company(UUID, UUID, UUID, JSONB, UUID[], UUID[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION crm_bulk_update_company(UUID, UUID, UUID, JSONB, UUID[], UUID[])
  TO service_role;
