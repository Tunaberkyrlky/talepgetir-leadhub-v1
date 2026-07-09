-- ==========================================
-- TG-Research v2 — contact enrichment (Hunter)  [102]
--
-- enrich:run finds decision-maker contacts for companies the customer selects:
-- Hunter domain-search (STRICT domain match — the response's domain must equal the
-- company's registrable domain or nothing persists), multilingual title-bucket
-- ranking (founder/purchasing/… — lib/research/enrichment/titleBundles.ts), a
-- per-company contact cap, and ONCE-EVER per-company billing (1 credit) through
-- the same fence + hold discipline as research_bill_match.
--
-- research_contacts ALREADY exists from the foundation schema (name/title/linkedin/
-- email/phone + contact-level suppression + tenant-scoped SELECT RLS + writes already
-- revoked for authenticated/anon) — this migration EXTENDS it with the Hunter fields
-- instead of shipping a parallel table.
--
-- Billing is a SEPARATE events table on purpose: research_billable_events' once-ever
-- key is UNIQUE(tenant_id, canonical_key) and research_bill_match's ON CONFLICT
-- targets it — enrichment rows there would collide with the MATCH invariant.
-- Credits pool is SHARED (research_usage_ledger): 1 enriched company = 1 credit.
-- ==========================================

-- ── Extend the foundation contacts table with enrichment provenance ──────────
ALTER TABLE research_contacts
  ADD COLUMN IF NOT EXISTS job_id       UUID REFERENCES research_jobs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS seniority    TEXT,
  ADD COLUMN IF NOT EXISTS department   TEXT,
  ADD COLUMN IF NOT EXISTS confidence   INTEGER,  -- Hunter 0-100
  ADD COLUMN IF NOT EXISTS title_bucket TEXT,     -- matched bundle code ('custom' | founder_exec | …); NULL = unranked fill
  ADD COLUMN IF NOT EXISTS domain       TEXT,     -- the STRICTLY matched domain the contact came from
  ADD COLUMN IF NOT EXISTS email_type   TEXT;     -- personal | generic

CREATE INDEX IF NOT EXISTS idx_research_contacts_company
  ON research_contacts(tenant_id, company_id);
-- Dedup guard for enrichment writes. PARTIAL (email may be NULL for scraped rows), so
-- the handler pre-filters existing emails instead of relying on ON CONFLICT inference.
CREATE UNIQUE INDEX IF NOT EXISTS uq_research_contacts_company_email
  ON research_contacts(tenant_id, company_id, email) WHERE email IS NOT NULL;

-- The foundation CHECK predates this provider — allow 'hunter' as a contact source.
ALTER TABLE research_contacts DROP CONSTRAINT research_contacts_source_check;
ALTER TABLE research_contacts ADD CONSTRAINT research_contacts_source_check
  CHECK (source = ANY (ARRAY['scrape'::text, 'betterenrich'::text, 'manual'::text, 'hunter'::text]));

-- ── Once-ever enrichment billing events (RPC-only writes) ────────────────────
CREATE TABLE IF NOT EXISTS research_enrichment_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id     UUID NOT NULL REFERENCES research_companies(id) ON DELETE CASCADE,
  canonical_key  TEXT NOT NULL,
  job_id         UUID,
  contacts_count INTEGER NOT NULL DEFAULT 0,
  ledger_id      UUID REFERENCES research_usage_ledger(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, canonical_key)
);
CREATE INDEX IF NOT EXISTS idx_research_enrichment_events_company
  ON research_enrichment_events(tenant_id, company_id);

ALTER TABLE research_enrichment_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY research_enrichment_events_select ON research_enrichment_events FOR SELECT
  USING (tenant_id = get_user_tenant_id() OR is_superadmin());
-- The billable_events discipline: NOBODY writes directly — not even service_role.
-- The SECURITY DEFINER RPC below (owner) is the only writer.
REVOKE INSERT, UPDATE, DELETE ON research_enrichment_events FROM PUBLIC, authenticated, anon, service_role;

-- ── Fenced, hold-aware, once-ever billing RPC ────────────────────────────────
CREATE OR REPLACE FUNCTION research_bill_enrichment(
  p_company_id UUID,
  p_job_id     UUID,
  p_hold_id    UUID,
  p_worker     TEXT,
  p_lease      UUID,
  p_contacts   INTEGER DEFAULT 0
) RETURNS research_enrichment_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant  UUID;
  v_canon   TEXT;
  v_supp    BOOLEAN;
  v_event   research_enrichment_events;
  v_hold    research_usage_holds;
  v_balance INTEGER;
  v_ledger  UUID;
BEGIN
  SELECT tenant_id, canonical_key, suppressed
    INTO v_tenant, v_canon, v_supp
  FROM research_companies WHERE id = p_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'research_bill_enrichment: company % not found', p_company_id;
  END IF;

  -- Same per-tenant lock family as research_bill_match: all ledger math serializes.
  PERFORM pg_advisory_xact_lock(hashtext('research_bill:' || v_tenant::text));

  IF v_supp OR EXISTS (
    SELECT 1 FROM research_suppression
    WHERE tenant_id = v_tenant AND entity_type = 'company' AND identity_key = v_canon
  ) THEN
    RAISE EXCEPTION 'research_bill_enrichment: refusing to bill suppressed company (tenant=%, key=%)',
      v_tenant, v_canon USING ERRCODE = 'check_violation';
  END IF;

  -- Structural fence: enrichment is always job-attributed; a reaped/zombie attempt bills NOTHING.
  IF p_job_id IS NULL OR p_worker IS NULL OR p_lease IS NULL THEN
    RAISE EXCEPTION 'research_bill_enrichment: job+worker+lease are required (company=%)', p_company_id;
  END IF;
  PERFORM 1 FROM research_jobs
    WHERE id = p_job_id AND tenant_id = v_tenant
      AND status = 'running' AND locked_by = p_worker AND lease = p_lease
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'research_bill_enrichment: lease lost for job % (worker=%, fenced — not billing)',
      p_job_id, p_worker;
  END IF;

  INSERT INTO research_enrichment_events
    (tenant_id, company_id, canonical_key, job_id, contacts_count)
  VALUES
    (v_tenant, p_company_id, v_canon, p_job_id, GREATEST(p_contacts, 0))
  ON CONFLICT (tenant_id, canonical_key) DO NOTHING
  RETURNING * INTO v_event;

  IF NOT FOUND THEN
    -- Already enriched once — idempotent dedup success, NO new charge.
    SELECT * INTO v_event FROM research_enrichment_events
      WHERE tenant_id = v_tenant AND canonical_key = v_canon;
    RETURN v_event;
  END IF;

  IF p_hold_id IS NULL THEN
    RAISE EXCEPTION 'research_bill_enrichment: a fresh charge requires a reservation hold';
  END IF;
  SELECT * INTO v_hold FROM research_usage_holds
    WHERE id = p_hold_id AND tenant_id = v_tenant
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'research_bill_enrichment: hold % not found for tenant %', p_hold_id, v_tenant;
  END IF;
  IF v_hold.status <> 'open' OR (v_hold.reserved - v_hold.settled) <= 0 THEN
    RAISE EXCEPTION
      'research_bill_enrichment: reservation exhausted (hold=%, reserved=%, settled=%, status=%)',
      p_hold_id, v_hold.reserved, v_hold.settled, v_hold.status
      USING ERRCODE = 'check_violation', DETAIL = 'RESERVATION_EXHAUSTED';
  END IF;

  v_balance := COALESCE((SELECT sum(delta) FROM research_usage_ledger WHERE tenant_id = v_tenant), 0) - 1;
  IF v_balance < 0 THEN
    RAISE EXCEPTION
      'research_bill_enrichment: insufficient credits (tenant=%, key=%, balance_would_be=%)',
      v_tenant, v_canon, v_balance USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO research_usage_ledger (tenant_id, delta, reason, ref_type, ref_id, balance_after)
  VALUES (v_tenant, -1, 'enrichment', 'enrichment_event', v_event.id, v_balance)
  RETURNING id INTO v_ledger;

  UPDATE research_usage_holds SET settled = settled + 1 WHERE id = p_hold_id;

  UPDATE research_enrichment_events SET ledger_id = v_ledger
    WHERE id = v_event.id
    RETURNING * INTO v_event;

  RETURN v_event;
END;
$$;

REVOKE EXECUTE ON FUNCTION research_bill_enrichment(UUID, UUID, UUID, TEXT, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION research_bill_enrichment(UUID, UUID, UUID, TEXT, UUID, INTEGER) TO service_role;
