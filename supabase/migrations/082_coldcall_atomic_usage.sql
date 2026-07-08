-- Codex review P1 düzeltmeleri:
--   * addUsedMinutes read-modify-write idi → eşzamanlı biten çağrılar artışı
--     kaybedebiliyordu (assertQuota bu alana bakıyor → kota aşımı mümkündü).
--   * Ay dönümünde finalize eski dönem satırına yazıp sonra reset'lenebiliyordu.
-- İki sorun tek atomik UPDATE'te çözülür: dönem devri + artış aynı statement'ta.
CREATE OR REPLACE FUNCTION coldcall_add_used_minutes(p_tenant_id UUID, p_minutes NUMERIC)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE coldcall_settings SET
    minutes_used = CASE
      WHEN period_start < date_trunc('month', now())::date THEN p_minutes
      ELSE minutes_used + p_minutes
    END,
    period_start = GREATEST(period_start, date_trunc('month', now())::date),
    updated_at = now()
  WHERE tenant_id = p_tenant_id;
$$;

-- Yalnız service role çağırır (020 revoke deseniyle tutarlı).
REVOKE EXECUTE ON FUNCTION coldcall_add_used_minutes(UUID, NUMERIC) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION coldcall_add_used_minutes(UUID, NUMERIC) FROM anon;
REVOKE EXECUTE ON FUNCTION coldcall_add_used_minutes(UUID, NUMERIC) FROM authenticated;
