-- Collapse the legacy product_portfolio list into product_services and remove
-- the obsolete schema contract. Environments where the column was already
-- removed are supported; the merge RPC is repaired in either case.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'companies'
      AND column_name = 'product_portfolio'
  ) THEN
    EXECUTE $merge_products$
      UPDATE companies c
      SET product_services = (
        SELECT array_agg(item ORDER BY ord)
        FROM (
          SELECT DISTINCT ON (lower(item)) item, ord
          FROM (
            SELECT btrim(elem) AS item, (base_ord * 1000 + eo) AS ord
            FROM (
              SELECT elem, eo, 0 AS base_ord
              FROM unnest(coalesce(
                CASE WHEN cardinality(c.product_services) = 1
                  THEN regexp_split_to_array(c.product_services[1], E'[;,|\n]+')
                  ELSE c.product_services
                END,
                '{}'
              )) WITH ORDINALITY u(elem, eo)

              UNION ALL

              SELECT elem, eo, 100 AS base_ord
              FROM unnest(coalesce(
                CASE WHEN cardinality(c.product_portfolio) = 1
                  THEN regexp_split_to_array(c.product_portfolio[1], E'[;,|\n]+')
                  ELSE c.product_portfolio
                END,
                '{}'
              )) WITH ORDINALITY u(elem, eo)
            ) all_elems
            WHERE btrim(elem) <> ''
          ) parts
          ORDER BY lower(item), ord
        ) dedup
      )
      WHERE c.product_services IS NOT NULL OR c.product_portfolio IS NOT NULL
    $merge_products$;
  END IF;
END $$;

-- Migration 136 created this RPC while product_portfolio still existed. Rebuild
-- it without that field before dropping the column so merge remains operational
-- on both already-migrated staging and fresh databases.
CREATE OR REPLACE FUNCTION merge_companies(
  p_tenant_id     UUID,
  p_source_id     UUID,
  p_target_id     UUID,
  p_field_winners JSONB DEFAULT '{}',
  p_performed_by  UUID  DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_source companies%ROWTYPE;
  v_target companies%ROWTYPE;
  v_fw      JSONB   := COALESCE(p_field_winners, '{}'::jsonb);
  v_has_archived BOOLEAN;
  v_target_has_primary BOOLEAN;
  v_moved   JSONB   := '{}'::jsonb;
  v_n       INTEGER;
  v_log_id  UUID;
BEGIN
  IF p_source_id = p_target_id THEN
    RAISE EXCEPTION 'merge: source and target must differ' USING ERRCODE = 'check_violation';
  END IF;

  PERFORM 1 FROM companies
   WHERE tenant_id = p_tenant_id AND id IN (p_source_id, p_target_id)
   ORDER BY id FOR UPDATE;

  SELECT * INTO v_source FROM companies WHERE id = p_source_id AND tenant_id = p_tenant_id;
  SELECT * INTO v_target FROM companies WHERE id = p_target_id AND tenant_id = p_tenant_id;

  IF v_source.id IS NULL THEN RAISE EXCEPTION 'merge: source company not found'; END IF;
  IF v_target.id IS NULL THEN RAISE EXCEPTION 'merge: target company not found'; END IF;
  IF v_source.merged_into_id IS NOT NULL THEN
    RAISE EXCEPTION 'source_already_merged' USING ERRCODE = 'check_violation';
  END IF;
  IF v_target.merged_into_id IS NOT NULL THEN
    RAISE EXCEPTION 'target_already_merged' USING ERRCODE = 'check_violation';
  END IF;

  UPDATE companies SET
    name             = CASE WHEN v_fw->>'name'             = 'source' THEN v_source.name             ELSE v_target.name             END,
    website          = CASE WHEN v_fw->>'website'          = 'source' THEN v_source.website          ELSE v_target.website          END,
    location         = CASE WHEN v_fw->>'location'         = 'source' THEN v_source.location         ELSE v_target.location         END,
    industry         = CASE WHEN v_fw->>'industry'         = 'source' THEN v_source.industry         ELSE v_target.industry         END,
    employee_size    = CASE WHEN v_fw->>'employee_size'    = 'source' THEN v_source.employee_size    ELSE v_target.employee_size    END,
    company_summary  = CASE WHEN v_fw->>'company_summary'  = 'source' THEN v_source.company_summary  ELSE v_target.company_summary  END,
    internal_notes   = CASE WHEN v_fw->>'internal_notes'   = 'source' THEN v_source.internal_notes   ELSE v_target.internal_notes   END,
    next_step        = CASE WHEN v_fw->>'next_step'        = 'source' THEN v_source.next_step        ELSE v_target.next_step        END,
    linkedin         = CASE WHEN v_fw->>'linkedin'         = 'source' THEN v_source.linkedin         ELSE v_target.linkedin         END,
    company_phone    = CASE WHEN v_fw->>'company_phone'    = 'source' THEN v_source.company_phone    ELSE v_target.company_phone    END,
    company_email    = CASE WHEN v_fw->>'company_email'    = 'source' THEN v_source.company_email    ELSE v_target.company_email    END,
    email_status     = CASE WHEN v_fw->>'email_status'     = 'source' THEN v_source.email_status     ELSE v_target.email_status     END,
    fit_score        = CASE WHEN v_fw->>'fit_score'        = 'source' THEN v_source.fit_score        ELSE v_target.fit_score        END,
    product_services = CASE WHEN v_fw->>'product_services' = 'source' THEN v_source.product_services ELSE v_target.product_services END
  WHERE id = p_target_id AND tenant_id = p_tenant_id;

  v_target_has_primary := EXISTS (
    SELECT 1 FROM contacts
     WHERE company_id = p_target_id AND tenant_id = p_tenant_id AND is_primary
  );
  UPDATE contacts
     SET company_id = p_target_id,
         is_primary = CASE WHEN v_target_has_primary THEN false ELSE is_primary END
   WHERE company_id = p_source_id AND tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_moved := v_moved || jsonb_build_object('contacts', v_n);

  UPDATE tasks SET company_id = p_target_id
   WHERE company_id = p_source_id AND tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_moved := v_moved || jsonb_build_object('tasks', v_n);

  UPDATE activities SET company_id = p_target_id
   WHERE company_id = p_source_id AND tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_moved := v_moved || jsonb_build_object('activities', v_n);

  IF to_regclass('public.leads') IS NOT NULL THEN
    EXECUTE 'UPDATE leads SET company_id = $1 WHERE company_id = $2 AND tenant_id = $3'
      USING p_target_id, p_source_id, p_tenant_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_moved := v_moved || jsonb_build_object('leads', v_n);
  END IF;

  IF to_regclass('public.deals') IS NOT NULL THEN
    EXECUTE 'UPDATE deals SET company_id = $1 WHERE company_id = $2 AND tenant_id = $3'
      USING p_target_id, p_source_id, p_tenant_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_moved := v_moved || jsonb_build_object('deals', v_n);
  END IF;

  UPDATE companies
     SET merged_into_id = p_target_id,
         internal_notes = btrim(
           COALESCE(internal_notes, '') ||
           CASE WHEN COALESCE(internal_notes, '') = '' THEN '' ELSE E'\n' END ||
           '[merged into ' || p_target_id::text || ' at ' || now()::text || ']')
   WHERE id = p_source_id AND tenant_id = p_tenant_id;

  v_has_archived := EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'companies' AND column_name = 'archived_at'
  );
  IF v_has_archived THEN
    EXECUTE 'UPDATE companies SET archived_at = now() WHERE id = $1 AND tenant_id = $2 AND archived_at IS NULL'
      USING p_source_id, p_tenant_id;
  END IF;

  INSERT INTO crm_merge_log (tenant_id, entity_type, source_id, target_id, field_choices, moved_counts, performed_by)
  VALUES (p_tenant_id, 'company', p_source_id, p_target_id, v_fw, v_moved, p_performed_by)
  RETURNING id INTO v_log_id;

  RETURN jsonb_build_object(
    'merge_log_id', v_log_id,
    'entity_type',  'company',
    'source_id',    p_source_id,
    'target_id',    p_target_id,
    'moved_counts', v_moved
  );
END;
$$;

REVOKE ALL ON FUNCTION merge_companies(UUID, UUID, UUID, JSONB, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION merge_companies(UUID, UUID, UUID, JSONB, UUID)
  TO service_role;

ALTER TABLE companies DROP COLUMN IF EXISTS product_portfolio;
