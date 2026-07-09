-- ==========================================
-- 097_linkedin_sequences.sql
-- TG-LinkedIn Faz 4 — campaign / sequence / enrollment engine + workspace suppression.
--
-- Turns the Faz-2/3 single-action primitives into a multi-step outreach engine (§5):
--   campaign → ordered sequence_steps (invite/message/wait) → enrollments (one lead per
--   campaign, driven by a sender account) advanced by linkedin:sequence-tick, with accept/
--   reply detection by linkedin:poll. Workspace-wide suppression (HeyReach model, §5) makes
--   two teammates unable to touch the same person, and any reply/opt-out stops + suppresses.
--
-- This is ALSO where the Faz-3 documented concurrency residuals close: the due-enrollment
-- CLAIM is per-account-SERIALIZED (at most one in-flight enrollment per sender account, and a
-- min-gap bumped into linkedin_accounts.next_available_at), so the engine never fires two
-- same-account sends at once (weekly-overshoot) or back-to-back (batch min-gap).
--
-- RLS: DENY-ALL (ENABLE + zero policies), mirroring 083 — all access is service-role via the
-- API/worker, which role-shapes the response (COGS/health stay internal). Additive + re-runnable.
-- ==========================================

-- ── Per-account pacing cursor (serialization floor for the claim below) ─────────
ALTER TABLE linkedin_accounts
  ADD COLUMN IF NOT EXISTS next_available_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- ── linkedin_leads — a target person, workspace-deduped by dedupe_key ───────────
CREATE TABLE IF NOT EXISTS linkedin_leads (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  profile_urn  TEXT,                                   -- urn:li:fsd_profile:<id> (null until resolved)
  public_id    TEXT,                                   -- vanity / public identifier
  first_name   TEXT, last_name TEXT, company TEXT, title TEXT,
  source       TEXT,                                   -- 'manual'|'csv'|'research'|…
  -- Normalized workspace identity key: the same real person imported twice (or by two
  -- teammates) collapses to one row. Chosen by the API (public_id > profile_urn > name+company).
  dedupe_key   TEXT NOT NULL,
  custom       JSONB NOT NULL DEFAULT '{}',            -- CSV custom vars for {var} personalization
  created_by   UUID REFERENCES auth.users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_linkedin_leads_tenant ON linkedin_leads(tenant_id);

-- ── linkedin_suppression — central workspace do-not-contact (§5 HeyReach model) ─
-- One row per identity per workspace. An identity here is skipped by every enroll and any
-- active enrollment for it is stopped. reason records WHY (reply/opt-out/connected/manual).
CREATE TABLE IF NOT EXISTS linkedin_suppression (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  dedupe_key   TEXT NOT NULL,
  reason       TEXT NOT NULL CHECK (reason IN ('connected','opted_out','do_not_contact','replied','bounced','manual')),
  lead_id      UUID REFERENCES linkedin_leads(id) ON DELETE SET NULL,
  created_by   UUID REFERENCES auth.users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_linkedin_suppression_tenant ON linkedin_suppression(tenant_id);

-- ── linkedin_campaigns — a named sequence + its rotation pool of sender accounts ─
CREATE TABLE IF NOT EXISTS linkedin_campaigns (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','active','paused','archived')),
  sender_account_ids UUID[] NOT NULL DEFAULT '{}',     -- rotation pool (§5 sender rotation)
  settings           JSONB NOT NULL DEFAULT '{}',      -- {withdraw_after_days, accept_wait_days, …}
  -- SAFE DEFAULT: a dry-run campaign advances the state machine + previews but sends NOTHING
  -- (no invite/message leaves the server). Flip to false only for a live campaign.
  dry_run            BOOLEAN NOT NULL DEFAULT true,
  created_by         UUID REFERENCES auth.users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_linkedin_campaigns_tenant ON linkedin_campaigns(tenant_id);

-- ── linkedin_sequence_steps — ordered steps of a campaign ──────────────────────
CREATE TABLE IF NOT EXISTS linkedin_sequence_steps (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id  UUID NOT NULL REFERENCES linkedin_campaigns(id) ON DELETE CASCADE,
  step_order   INTEGER NOT NULL,                        -- 0-based position
  type         TEXT NOT NULL CHECK (type IN ('invite','message','wait')),
  wait_days    NUMERIC NOT NULL DEFAULT 0,              -- delay BEFORE this step fires
  template     TEXT,                                    -- invite note / message body (spintax + {vars})
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, step_order)
);
CREATE INDEX IF NOT EXISTS idx_linkedin_sequence_steps_campaign ON linkedin_sequence_steps(campaign_id, step_order);

-- ── linkedin_enrollments — one lead progressing through one campaign ───────────
CREATE TABLE IF NOT EXISTS linkedin_enrollments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id    UUID NOT NULL REFERENCES linkedin_campaigns(id) ON DELETE CASCADE,
  lead_id        UUID NOT NULL REFERENCES linkedin_leads(id) ON DELETE CASCADE,
  account_id     UUID REFERENCES linkedin_accounts(id) ON DELETE SET NULL,  -- assigned sender
  current_step   INTEGER NOT NULL DEFAULT 0,
  state          TEXT NOT NULL DEFAULT 'pending'
                 CHECK (state IN ('pending','invited','accepted','messaged','replied','stopped','failed','completed')),
  next_action_at TIMESTAMPTZ NOT NULL DEFAULT now(),    -- when the tick should next touch it
  last_error     TEXT,
  locked_at      TIMESTAMPTZ,                           -- tick lease (claim serialization)
  locked_by      TEXT,
  created_by     UUID REFERENCES auth.users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, lead_id)                          -- a lead enrolled once per campaign
);
-- Hot-path for the due-enrollment claim: non-terminal, due, ordered.
CREATE INDEX IF NOT EXISTS idx_linkedin_enrollments_due
  ON linkedin_enrollments(next_action_at)
  WHERE state IN ('pending','invited','accepted','messaged');
CREATE INDEX IF NOT EXISTS idx_linkedin_enrollments_lead ON linkedin_enrollments(tenant_id, lead_id);
CREATE INDEX IF NOT EXISTS idx_linkedin_enrollments_account ON linkedin_enrollments(account_id);

-- ── RLS: deny-all (ENABLE, zero policies) ──────────────────────────────────────
ALTER TABLE linkedin_leads           ENABLE ROW LEVEL SECURITY;
ALTER TABLE linkedin_suppression     ENABLE ROW LEVEL SECURITY;
ALTER TABLE linkedin_campaigns       ENABLE ROW LEVEL SECURITY;
ALTER TABLE linkedin_sequence_steps  ENABLE ROW LEVEL SECURITY;
ALTER TABLE linkedin_enrollments     ENABLE ROW LEVEL SECURITY;

-- ── updated_at triggers ─────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS linkedin_leads_updated_at ON linkedin_leads;
CREATE TRIGGER linkedin_leads_updated_at BEFORE UPDATE ON linkedin_leads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
DROP TRIGGER IF EXISTS linkedin_campaigns_updated_at ON linkedin_campaigns;
CREATE TRIGGER linkedin_campaigns_updated_at BEFORE UPDATE ON linkedin_campaigns
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
DROP TRIGGER IF EXISTS linkedin_enrollments_updated_at ON linkedin_enrollments;
CREATE TRIGGER linkedin_enrollments_updated_at BEFORE UPDATE ON linkedin_enrollments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ══════════════════════════════════════════════════════════════════════════════
-- RPCs (service-role only). All SECURITY DEFINER + search_path pinned.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── Atomic enroll (§5 dedup/suppression gate) ──────────────────────────────────
-- Rejects (never inserts) when: the identity is workspace-suppressed; the lead already has a
-- non-terminal enrollment in ANOTHER campaign (one active campaign per lead); or it's already
-- enrolled in THIS campaign. The lead row is locked FOR UPDATE first (codex P2), so two
-- concurrent enrolls of the SAME lead — into two campaigns, or racing a suppress — serialize on
-- that row instead of both passing their EXISTS check (write-skew). Returns {enrolled, reason}.
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

  -- One active campaign per lead: block if a non-terminal enrollment exists elsewhere.
  IF EXISTS (SELECT 1 FROM linkedin_enrollments
              WHERE tenant_id = p_tenant AND lead_id = p_lead
                AND campaign_id <> p_campaign
                AND state IN ('pending','invited','accepted','messaged')) THEN
    RETURN jsonb_build_object('enrolled', false, 'reason', 'in_another_campaign');
  END IF;

  -- Insert (or report the existing) enrollment for THIS campaign.
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

-- ── Per-account-serialized claim of due enrollments ────────────────────────────
-- Returns up to p_limit enrollments that are due (next_action_at <= now), non-terminal, in an
-- ACTIVE campaign, whose sender account is ACTIVE and past its pacing cursor. AT MOST ONE per
-- account (DISTINCT ON account_id) so the engine never runs two same-account sends at once.
-- Each claim leases the row (locked_by/locked_at) and pushes the account's next_available_at
-- out by p_min_gap_seconds — the §2 min-gap that Faz-3 could not guarantee for batches.
-- FOR UPDATE SKIP LOCKED lets many workers claim disjoint sets concurrently.
--
-- LEASE TTL: FOR UPDATE only holds while the CLAIM transaction runs; once it commits the row
-- is unlocked at the DB level while the tick is still SENDING. Without a lease guard a second
-- worker could re-claim the same still-due enrollment and double-send. So the claim also
-- excludes rows leased within p_lease_ttl_seconds (a crashed tick's lease expires and the row
-- is reclaimed after the TTL). The tick clears locked_at when it finishes, releasing early.
CREATE OR REPLACE FUNCTION linkedin_claim_due_enrollments(
  p_tenant            UUID,
  p_worker            TEXT,
  p_limit             INTEGER,
  p_min_gap_seconds   INTEGER,
  p_lease_ttl_seconds INTEGER
)
RETURNS SETOF linkedin_enrollments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ids UUID[];
BEGIN
  -- Postgres forbids FOR UPDATE with DISTINCT, so lock a candidate POOL (SKIP LOCKED, no
  -- DISTINCT) then dedup to one-per-account. Un-picked pool rows are released at commit — the
  -- per-account pacing (next_available_at bump below) gives fair rotation across ticks.
  WITH pool AS (
    SELECT e.id, e.account_id, e.next_action_at
      FROM linkedin_enrollments e
      JOIN linkedin_campaigns c ON c.id = e.campaign_id AND c.status = 'active'
      JOIN linkedin_accounts  a ON a.id = e.account_id  AND a.status = 'ACTIVE'
                                AND a.next_available_at <= now()
     WHERE e.tenant_id = p_tenant
       AND e.next_action_at <= now()
       AND e.state IN ('pending','invited','accepted','messaged')
       AND e.account_id IS NOT NULL
       AND (e.locked_at IS NULL OR e.locked_at < now() - make_interval(secs => GREATEST(p_lease_ttl_seconds, 0)))
     ORDER BY e.next_action_at
     FOR UPDATE OF e SKIP LOCKED
     LIMIT GREATEST(p_limit, 1) * 5
  ), picked AS (
    SELECT DISTINCT ON (account_id) id
      FROM pool
     ORDER BY account_id, next_action_at
     LIMIT p_limit
  )
  SELECT array_agg(id) INTO v_ids FROM picked;

  IF v_ids IS NULL THEN RETURN; END IF;

  -- Lease the claimed enrollments.
  UPDATE linkedin_enrollments
     SET locked_by = p_worker, locked_at = now(), updated_at = now()
   WHERE id = ANY(v_ids);

  -- Advance each claimed account's pacing cursor so the next tick can't re-pick it too soon.
  UPDATE linkedin_accounts
     SET next_available_at = now() + make_interval(secs => GREATEST(p_min_gap_seconds, 0)),
         updated_at = now()
   WHERE id IN (SELECT account_id FROM linkedin_enrollments WHERE id = ANY(v_ids));

  RETURN QUERY SELECT * FROM linkedin_enrollments WHERE id = ANY(v_ids);
END;
$$;

-- ── Suppress an identity + stop its active enrollments (reply/opt-out/global stop) ─
-- Idempotent upsert of the suppression row, then stop every non-terminal enrollment for that
-- identity across ALL the workspace's campaigns (§5 global stop). Returns {suppressed, stopped}.
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
  ON CONFLICT (tenant_id, dedupe_key) DO NOTHING;

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

REVOKE ALL ON FUNCTION linkedin_enroll_lead(UUID, UUID, UUID, UUID, TIMESTAMPTZ)   FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION linkedin_enroll_lead(UUID, UUID, UUID, UUID, TIMESTAMPTZ) TO service_role;
REVOKE ALL ON FUNCTION linkedin_claim_due_enrollments(UUID, TEXT, INTEGER, INTEGER, INTEGER)    FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION linkedin_claim_due_enrollments(UUID, TEXT, INTEGER, INTEGER, INTEGER) TO service_role;
REVOKE ALL ON FUNCTION linkedin_suppress_identity(UUID, TEXT, TEXT, UUID)           FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION linkedin_suppress_identity(UUID, TEXT, TEXT, UUID)        TO service_role;
