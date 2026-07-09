-- ==========================================
-- 101_linkedin_retention.sql
-- TG-LinkedIn Faz 5 — PII retention purge + supporting RPCs (§6 uyumluluk, hardening).
--
-- Ships FOUR service-role RPCs:
--   1. linkedin_purge_retention  — daily PII retention (old audit + stale-lead anonymize).
--   2. linkedin_replace_steps    — atomic sequence-step replace (delete+insert in ONE txn) so a
--      concurrent sequence-tick never sees zero steps mid-edit and wrongly completes a live lead.
--   3. linkedin_account_usage    — per-account rolling-7-day landed-send counts via GROUP BY
--      (the accounts health columns; replaces a client-side query that db-max-rows truncated).
--   4. linkedin_suppress_identity — REDEFINED from 097 to ESCALATE reason on conflict: a permanent
--      stop (replied/opted_out/connected/bounced) overrides a removable row (manual/do_not_contact)
--      so a poll-detected reply can never be left deletable via the Faz-5 DELETE endpoint.
--
-- RLS unchanged (deny-all). Service-role only. Additive + re-runnable (all CREATE OR REPLACE).
-- ==========================================

-- ── 1. Retention purge ─────────────────────────────────────────────────────────
-- One RPC the linkedin:retention job calls daily per tenant:
--   * linkedin_actions older than p_days are DELETED (target URNs + error strings).
--   * Expired linkedin_link_tokens older than 7 days are deleted (single-use pairing hashes).
--   * Stale leads are ANONYMIZED (enrollment stats survive; identifying columns nulled). A lead
--     is stale when nothing touched it since the cutoff and it has no live enrollment.
--
-- SUPPRESSION-AWARE ANONYMIZE: a suppressed (opt-out/reply/DNC) identity still gets its PII
-- (name/company/title/public_id/urn/custom) nulled, but KEEPS its dedupe_key so the suppression
-- row keeps matching — the person can never be re-imported + re-contacted. A non-suppressed
-- stale lead is fully anonymized AND its dedupe_key relabeled 'purged:<id>' (identity-free).
-- Either way no scraped PII is retained past the window — the §6 requirement.
--
-- KNOWN BOUND (accepted): under READ COMMITTED an enroll that lands in the same instant the
-- purge scans can see its lead anonymized (the engine then fails that enrollment 'no_identity',
-- fail-safe direction). Window ≈ one statement on a lead idle for p_days — not worth SERIALIZABLE.
CREATE OR REPLACE FUNCTION linkedin_purge_retention(
  p_tenant UUID,
  p_days   INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- Floor 30: a caller can never weaponize the purge to wipe fresh operational audit.
  v_days    INTEGER := GREATEST(COALESCE(p_days, 90), 30);
  v_cutoff  TIMESTAMPTZ;
  v_actions INTEGER := 0;
  v_tokens  INTEGER := 0;
  v_leads   INTEGER := 0;
BEGIN
  v_cutoff := now() - make_interval(days => v_days);

  DELETE FROM linkedin_actions
   WHERE tenant_id = p_tenant AND created_at < v_cutoff;
  GET DIAGNOSTICS v_actions = ROW_COUNT;

  DELETE FROM linkedin_link_tokens
   WHERE tenant_id = p_tenant AND expires_at < now() - interval '7 days';
  GET DIAGNOSTICS v_tokens = ROW_COUNT;

  -- Stale = untouched since cutoff + no live enrollment + no enrollment activity since cutoff
  -- + not already purged. Suppressed leads are INCLUDED (PII nulled) but keep their key below.
  -- SKIP LOCKED: never block a concurrent enroll's FOR UPDATE — skip it this run, catch it next.
  WITH stale AS (
    SELECT l.id,
           EXISTS (SELECT 1 FROM linkedin_suppression s
                    WHERE s.tenant_id = p_tenant AND s.dedupe_key = l.dedupe_key) AS suppressed
      FROM linkedin_leads l
     WHERE l.tenant_id = p_tenant
       AND l.updated_at < v_cutoff
       AND l.dedupe_key NOT LIKE 'purged:%'
       AND NOT EXISTS (SELECT 1 FROM linkedin_enrollments e
                        WHERE e.lead_id = l.id
                          AND (e.state IN ('pending','invited','accepted','messaged')
                               OR e.updated_at >= v_cutoff))
       FOR UPDATE OF l SKIP LOCKED
  )
  UPDATE linkedin_leads l
     SET profile_urn = NULL,
         public_id   = NULL,
         first_name  = NULL,
         last_name   = NULL,
         company     = NULL,
         title       = NULL,
         custom      = '{}'::jsonb,
         -- Suppressed identity keeps its key (suppression must keep matching); otherwise relabel.
         dedupe_key  = CASE WHEN stale.suppressed THEN l.dedupe_key ELSE 'purged:' || l.id::text END,
         updated_at  = now()
    FROM stale
   WHERE l.id = stale.id;
  GET DIAGNOSTICS v_leads = ROW_COUNT;

  RETURN jsonb_build_object(
    'actions_deleted', v_actions,
    'tokens_deleted',  v_tokens,
    'leads_purged',    v_leads,
    'retention_days',  v_days
  );
END;
$$;

-- ── 2. Atomic sequence-step replace ────────────────────────────────────────────
-- PUT /:id/steps used a non-transactional delete-then-insert; a sequence-tick that read steps in
-- the gap saw [] and terminally 'completed' live enrollments. Running both DML in one function =
-- one transaction, so a concurrent reader sees either the whole old list or the whole new one.
-- p_steps is a JSONB array of {type, wait_days, template}; ordinality gives step_order.
CREATE OR REPLACE FUNCTION linkedin_replace_steps(
  p_tenant   UUID,
  p_campaign UUID,
  p_steps    JSONB
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER := 0;
BEGIN
  -- Ownership guard (defense in depth; the route already checked).
  PERFORM 1 FROM linkedin_campaigns WHERE id = p_campaign AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'linkedin_replace_steps: campaign % not found for tenant %', p_campaign, p_tenant;
  END IF;

  DELETE FROM linkedin_sequence_steps WHERE campaign_id = p_campaign;

  INSERT INTO linkedin_sequence_steps (tenant_id, campaign_id, step_order, type, wait_days, template)
  SELECT p_tenant, p_campaign, (ord - 1)::int,
         elem->>'type',
         COALESCE((elem->>'wait_days')::numeric, 0),
         NULLIF(elem->>'template', '')
    FROM jsonb_array_elements(COALESCE(p_steps, '[]'::jsonb)) WITH ORDINALITY AS t(elem, ord);
  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN v_count;
END;
$$;

-- ── 3. Per-account rolling-7-day landed-send counts ────────────────────────────
-- The accounts health columns need per-account invite/message counts. A single client-side
-- select was clamped by PostgREST db-max-rows (default 1000) and truncated near the caps. This
-- GROUP BY runs server-side over the full 7-day window — exact regardless of volume.
CREATE OR REPLACE FUNCTION linkedin_account_usage(
  p_tenant      UUID,
  p_account_ids UUID[]
)
RETURNS TABLE (account_id UUID, invites INTEGER, messages INTEGER)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.account_id,
         COALESCE(SUM((a.type = 'invite')::int), 0)::int  AS invites,
         COALESCE(SUM((a.type = 'message')::int), 0)::int AS messages
    FROM linkedin_actions a
   WHERE a.tenant_id = p_tenant
     AND a.account_id = ANY(p_account_ids)
     AND a.status = 'ok'
     AND a.type IN ('invite','message')
     AND a.created_at > now() - interval '7 days'
   GROUP BY a.account_id;
$$;

-- ── 4. Suppress an identity — REDEFINED from 097 with reason ESCALATION ─────────
-- Same as 097 (idempotent upsert + stop non-terminal enrollments across the workspace) EXCEPT
-- the ON CONFLICT now ESCALATES: a permanent stop (replied/opted_out/connected/bounced) overrides
-- a removable existing reason (manual/do_not_contact). Faz 5's DELETE /suppression only removes
-- manual/do_not_contact rows, so without escalation a poll-detected reply that raced an operator's
-- do_not_contact row would be swallowed (DO NOTHING) and left deletable — breaking the "a person's
-- stop request can't be undone" invariant. Never downgrades (permanent stays permanent).
CREATE OR REPLACE FUNCTION linkedin_suppress_identity(
  p_tenant  UUID,
  p_key     TEXT,
  p_reason  TEXT,
  p_lead    UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_stopped INTEGER := 0;
BEGIN
  IF p_reason NOT IN ('connected','opted_out','do_not_contact','replied','bounced','manual') THEN
    RAISE EXCEPTION 'linkedin_suppress_identity: invalid reason %', p_reason;
  END IF;

  -- Lock the lead row(s) for this identity FIRST (codex P2): serializes against a concurrent
  -- enroll of the same lead, so suppress can't insert-then-stop while enroll is mid check-then-
  -- insert (which would otherwise leave an ACTIVE enrollment for a just-suppressed identity).
  PERFORM 1 FROM linkedin_leads
   WHERE tenant_id = p_tenant AND dedupe_key = p_key
   FOR UPDATE;

  INSERT INTO linkedin_suppression (tenant_id, dedupe_key, reason, lead_id)
  VALUES (p_tenant, p_key, p_reason, p_lead)
  ON CONFLICT (tenant_id, dedupe_key) DO UPDATE
    SET reason  = EXCLUDED.reason,
        lead_id = COALESCE(linkedin_suppression.lead_id, EXCLUDED.lead_id)
    WHERE linkedin_suppression.reason IN ('manual','do_not_contact')
      AND EXCLUDED.reason IN ('opted_out','replied','connected','bounced');

  UPDATE linkedin_enrollments e
     SET state = 'stopped', updated_at = now(),
         last_error = COALESCE(last_error, 'suppressed:' || p_reason)
    FROM linkedin_leads l
   WHERE e.lead_id = l.id
     AND e.tenant_id = p_tenant AND l.dedupe_key = p_key
     AND e.state IN ('pending','invited','accepted','messaged');
  GET DIAGNOSTICS v_stopped = ROW_COUNT;

  RETURN jsonb_build_object('suppressed', true, 'stopped', v_stopped);
END;
$$;

REVOKE ALL ON FUNCTION linkedin_purge_retention(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION linkedin_purge_retention(UUID, INTEGER) TO service_role;
REVOKE ALL ON FUNCTION linkedin_replace_steps(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION linkedin_replace_steps(UUID, UUID, JSONB) TO service_role;
REVOKE ALL ON FUNCTION linkedin_account_usage(UUID, UUID[]) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION linkedin_account_usage(UUID, UUID[]) TO service_role;
REVOKE ALL ON FUNCTION linkedin_suppress_identity(UUID, TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION linkedin_suppress_identity(UUID, TEXT, TEXT, UUID) TO service_role;
