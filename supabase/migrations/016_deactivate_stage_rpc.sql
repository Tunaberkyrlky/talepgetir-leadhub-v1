-- supabase/migrations/016_deactivate_stage_rpc.sql
-- Atomic stage deactivation: migrate companies + set is_active=false in one transaction.

CREATE OR REPLACE FUNCTION deactivate_pipeline_stage(
    p_tenant_id uuid,
    p_slug text,
    p_migrations jsonb,        -- [{company_ids: [uuid,...], target_stage: "slug"}, ...]
    p_fallback_stage text
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    v_batch jsonb;
    v_moved int := 0;
    v_remaining int;
BEGIN
    -- Apply explicit migrations (batched by target stage)
    FOR v_batch IN SELECT * FROM jsonb_array_elements(p_migrations)
    LOOP
        UPDATE companies
        SET stage = v_batch->>'target_stage',
            updated_at = now()
        WHERE tenant_id = p_tenant_id
          AND id IN (SELECT (jsonb_array_elements_text(v_batch->'company_ids'))::uuid)
          AND stage = p_slug;

        GET DIAGNOSTICS v_remaining = ROW_COUNT;
        v_moved := v_moved + v_remaining;
    END LOOP;

    -- Move any remaining companies in this stage to the fallback (initial) stage
    UPDATE companies
    SET stage = p_fallback_stage,
        updated_at = now()
    WHERE tenant_id = p_tenant_id
      AND stage = p_slug;

    GET DIAGNOSTICS v_remaining = ROW_COUNT;
    v_moved := v_moved + v_remaining;

    -- Deactivate the stage
    UPDATE pipeline_stages
    SET is_active = false
    WHERE tenant_id = p_tenant_id
      AND slug = p_slug;

    RETURN jsonb_build_object('companies_moved', v_moved);
END;
$$;
