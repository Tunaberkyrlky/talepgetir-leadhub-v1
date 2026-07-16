-- ==========================================
-- Ledger-aligned version: applied to TG-Research test as 20260716171643.
-- TG-LinkedIn — refine the one-active-campaign enroll gate (fix 'in_another_campaign' false block).
--
-- BUG (user-reported): a lead could not be added to a NEW campaign because it still sat in a
-- DRAFT campaign's pending enrollment — the RPC returned reason 'in_another_campaign'. But a draft
-- campaign has never sent anything (only 'active'/'paused' campaigns can send), so it should never
-- block a fresh enrollment. This migration replaces linkedin_enroll_lead (mig 097) so that the
-- one-active-campaign gate only fires against campaigns that CAN send, and supersedes stale
-- draft/archived enrollments instead of blocking on them.
--
-- Signature / style / return shapes are IDENTICAL to 097 (SECURITY DEFINER, search_path pinned,
-- lead row FOR UPDATE lock, suppression check unchanged). Additive + re-runnable (CREATE OR REPLACE).
--
-- Concurrency/ordering hardening in this revision:
--   S1 — the one-live-campaign gate now locks the OTHER campaigns' rows (FOR UPDATE OF c) before
--        deciding block-vs-supersede, so a concurrent POST /:id/activate cannot flip a draft→active
--        in the check→insert window and leave one lead non-terminal in two live campaigns.
--   S2 — the already-in-THIS-campaign case returns BEFORE any supersede, so a no-op enroll never
--        has the destructive side effect of stopping the lead's draft-campaign enrollments.
--   Order: lead lock → suppression → already-in-this-campaign → locked-status gate → supersede → insert.
-- ==========================================

CREATE OR REPLACE FUNCTION linkedin_enroll_lead(
  p_tenant   UUID,
  p_campaign UUID,
  p_lead     UUID,
  p_account  UUID,
  p_first_at TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key   TEXT;
  v_id    UUID;
  v_rec   RECORD;
  v_block BOOLEAN := false;
BEGIN
  -- Lock the lead row: serializes concurrent same-lead enroll/suppress so the checks below are
  -- atomic w.r.t. each other. Also yields the dedupe_key for the suppression check.
  SELECT dedupe_key INTO v_key FROM linkedin_leads
   WHERE id = p_lead AND tenant_id = p_tenant
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('enrolled', false, 'reason', 'lead_not_found');
  END IF;

  -- Workspace suppression: never contact a suppressed identity.
  IF EXISTS (SELECT 1 FROM linkedin_suppression
              WHERE tenant_id = p_tenant AND dedupe_key = v_key) THEN
    RETURN jsonb_build_object('enrolled', false, 'reason', 'suppressed');
  END IF;

  -- S2 (no destructive supersede on a no-op): if this lead is ALREADY enrolled in THIS campaign, the
  -- insert below would no-op with reason 'already_enrolled'. Detect that FIRST and return here, BEFORE
  -- the supersede UPDATE runs — otherwise a call that changes nothing (already_enrolled) would still
  -- have stopped this lead's draft-campaign enrollments as a side effect. This is also cheaper (skips
  -- the campaign-lock loop + supersede entirely). Order from here: lead lock → suppression →
  -- already-in-this-campaign → locked-status gate → supersede → insert.
  IF EXISTS (SELECT 1 FROM linkedin_enrollments
              WHERE tenant_id = p_tenant AND campaign_id = p_campaign AND lead_id = p_lead) THEN
    RETURN jsonb_build_object('enrolled', false, 'reason', 'already_enrolled');
  END IF;

  -- One SENDING campaign per lead: block ONLY when a non-terminal enrollment exists in ANOTHER
  -- campaign that can actually send — status IN ('active','paused'). Two live campaigns must never
  -- both message one person, so this hard-blocks with reason 'in_another_campaign' (unchanged shape).
  --
  -- S1 (campaign-activation race): a plain `... c.status IN ('active','paused')` EXISTS check reads
  -- the owning campaigns' status WITHOUT locking those rows. A concurrent POST /:id/activate could
  -- flip a draft→active in the window between this check and the supersede/insert below, leaving the
  -- SAME lead non-terminal in TWO live campaigns (invariant broken). Fix: SELECT the owning campaign
  -- rows of this lead's OTHER non-terminal enrollments FOR UPDATE OF c and decide block-vs-supersede
  -- from those LOCKED statuses. activate's UPDATE of linkedin_campaigns.status now serializes on the
  -- row lock — it either committed before us (our locked read sees 'active' → we block) or waits for
  -- our commit (it flips a campaign we already superseded, harmlessly). Either way, no double-live lead.
  FOR v_rec IN
    SELECT c.status AS status
      FROM linkedin_enrollments e
      JOIN linkedin_campaigns c ON c.id = e.campaign_id
     WHERE e.tenant_id = p_tenant AND e.lead_id = p_lead
       AND e.campaign_id <> p_campaign
       AND e.state IN ('pending','invited','accepted','messaged')
     FOR UPDATE OF c
  LOOP
    IF v_rec.status IN ('active','paused') THEN
      v_block := true;  -- keep looping so ALL owning campaign rows are locked before we decide
    END IF;
  END LOOP;

  IF v_block THEN
    RETURN jsonb_build_object('enrolled', false, 'reason', 'in_another_campaign');
  END IF;

  -- Supersede stale enrollments: any non-terminal enrollment of this lead in ANOTHER campaign whose
  -- status is 'draft' (or 'archived', defensively) has never sent — a draft campaign cannot send, and
  -- archiving stops enrollments so 'archived' shouldn't co-occur with a non-terminal state, but we
  -- handle it anyway. The operator's intent to enroll elsewhere supersedes those, so mark them
  -- 'stopped' rather than blocking the new enrollment. Safe to re-read c.status here: we hold FOR
  -- UPDATE locks on exactly these campaign rows from the loop above, so no concurrent activate can
  -- have flipped a draft to active between the gate decision and this UPDATE.
  --
  -- Correctness note: superseding ALL non-terminal states (not just 'pending') is safe here because
  -- an INVITED/ACCEPTED/MESSAGED enrollment in a DRAFT campaign is impossible in the current
  -- lifecycle — a real invite/message only goes out while the campaign is 'active', and there is NO
  -- active→draft transition (activation sets 'active'; pause is active→paused; archive is
  -- draft/paused→archived; nothing ever sets 'draft' back). So in practice only 'pending' rows are
  -- superseded; the broader IN(...) is defensive, not a behavioral widening.
  UPDATE linkedin_enrollments e
     SET state = 'stopped',
         last_error = 'superseded_by_new_campaign',
         updated_at = now()
    FROM linkedin_campaigns c
   WHERE c.id = e.campaign_id
     AND e.tenant_id = p_tenant AND e.lead_id = p_lead
     AND e.campaign_id <> p_campaign
     AND e.state IN ('pending','invited','accepted','messaged')
     AND c.status IN ('draft','archived');

  -- Insert the enrollment for THIS campaign. The already-enrolled case is handled up front (S2), so
  -- ON CONFLICT DO NOTHING here is purely defensive — the lead FOR UPDATE lock serializes same-lead
  -- calls, so a conflict is not expected, but if one somehow occurs we still report already_enrolled
  -- rather than raise (and by that point no supersede ran, because a conflicting row would also have
  -- satisfied the S2 EXISTS check).
  INSERT INTO linkedin_enrollments (tenant_id, campaign_id, lead_id, account_id, next_action_at)
  VALUES (p_tenant, p_campaign, p_lead, p_account, COALESCE(p_first_at, now()))
  ON CONFLICT (campaign_id, lead_id) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RETURN jsonb_build_object('enrolled', false, 'reason', 'already_enrolled');
  END IF;
  RETURN jsonb_build_object('enrolled', true, 'reason', 'ok', 'enrollment_id', v_id);
END;
$$;

REVOKE ALL ON FUNCTION linkedin_enroll_lead(UUID, UUID, UUID, UUID, TIMESTAMPTZ)   FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION linkedin_enroll_lead(UUID, UUID, UUID, UUID, TIMESTAMPTZ) TO service_role;
