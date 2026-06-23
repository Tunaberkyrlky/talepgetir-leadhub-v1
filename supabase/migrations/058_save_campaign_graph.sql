-- Faz 2 Batch 3: görsel editör grafı kaydeder. Client-üretimi STABİL id'lerle
-- upsert + prune — eski delete+reinsert'in (yeni UUID) kenar id'lerini bozma sorununu
-- çözer. Tek transaction. FK pointer'lar DEFERRABLE (057) olduğundan aynı batch içinde
-- ileri-referans (A→henüz-eklenmemiş B) commit'te doğrulanır.
CREATE OR REPLACE FUNCTION save_campaign_graph(p_campaign_id uuid, p_nodes jsonb)
RETURNS SETOF campaign_steps
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- Giriş bayraklarını önce temizle: uq_campaign_one_entry (partial unique, deferrable
    -- DEĞİL) upsert sırasında iki satırın geçici olarak is_entry=true olmasında patlar;
    -- önce sıfırlayınca payload'daki tek giriş node'u güvenle set edilir.
    UPDATE campaign_steps SET is_entry = false WHERE campaign_id = p_campaign_id;

    INSERT INTO campaign_steps (
        id, campaign_id, step_order, step_type, step_kind,
        subject, body_html, body_text, delay_days, delay_hours,
        condition_type, condition_wait_hours,
        next_step_id, condition_true_step_id, condition_false_step_id,
        is_entry, config
    )
    SELECT
        (n->>'id')::uuid, p_campaign_id,
        COALESCE((n->>'step_order')::int, 0),
        n->>'step_type',
        COALESCE(NULLIF(n->>'step_kind', ''), n->>'step_type'),
        n->>'subject', n->>'body_html', n->>'body_text',
        COALESCE((n->>'delay_days')::int, 0), COALESCE((n->>'delay_hours')::int, 0),
        NULLIF(n->>'condition_type', ''), COALESCE((n->>'condition_wait_hours')::int, 72),
        NULLIF(n->>'next_step_id', '')::uuid,
        NULLIF(n->>'condition_true_step_id', '')::uuid,
        NULLIF(n->>'condition_false_step_id', '')::uuid,
        COALESCE((n->>'is_entry')::boolean, false),
        COALESCE(n->'config', '{}'::jsonb)
    FROM jsonb_array_elements(p_nodes) AS n
    ON CONFLICT (id) DO UPDATE SET
        step_order = EXCLUDED.step_order,
        step_type = EXCLUDED.step_type,
        step_kind = EXCLUDED.step_kind,
        subject = EXCLUDED.subject,
        body_html = EXCLUDED.body_html,
        body_text = EXCLUDED.body_text,
        delay_days = EXCLUDED.delay_days,
        delay_hours = EXCLUDED.delay_hours,
        condition_type = EXCLUDED.condition_type,
        condition_wait_hours = EXCLUDED.condition_wait_hours,
        next_step_id = EXCLUDED.next_step_id,
        condition_true_step_id = EXCLUDED.condition_true_step_id,
        condition_false_step_id = EXCLUDED.condition_false_step_id,
        is_entry = EXCLUDED.is_entry,
        config = EXCLUDED.config,
        updated_at = now();

    -- Payload'da olmayan node'ları sil (silinen node'lar).
    DELETE FROM campaign_steps
    WHERE campaign_id = p_campaign_id
      AND id NOT IN (SELECT (n->>'id')::uuid FROM jsonb_array_elements(p_nodes) AS n);

    RETURN QUERY SELECT * FROM campaign_steps WHERE campaign_id = p_campaign_id ORDER BY step_order;
END $$;
