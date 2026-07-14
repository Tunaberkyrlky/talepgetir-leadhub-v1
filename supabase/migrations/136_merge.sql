-- Tibexa CRM Expansion v2 — Phase 8: duplicate detection + record merge  [136]
--
-- FILE-ONLY: do NOT apply from this worktree. Ordering guarantees:
--   * 133_deals_adapter (parallel slice E1) creates deals / deal_contacts — this
--     migration references them ONLY behind to_regclass guards so 136 also applies
--     stand-alone (before 133 has landed) without erroring.
--   * 137 (parallel slice E9) adds companies.archived_at — the merge RPC checks
--     information_schema before writing it and falls back to an internal_notes
--     marker, so 136 works both alone AND alongside 137.
--   * 121 created leads — likewise guarded (task spec: "leads.company_id, if it exists").
--
-- What ships here:
--   1. crm_norm_* IMMUTABLE helpers (name / domain / phone normalisation)
--   2. crm_merge_log  — append-only audit of every merge (RLS + tenant fence)
--   3. find_duplicate_companies / find_duplicate_contacts — normalised, tenant-scoped
--   4. merge_companies / merge_contacts — single-transaction, atomic merge RPCs
--
-- RLS/RPC posture copied from 114/115/119: tenant_id FK CASCADE, ENABLE RLS,
-- SECURITY DEFINER + SET search_path=public + explicit p_tenant_id (never trust the
-- JWT), REVOKE PUBLIC/anon/authenticated + GRANT service_role. The API always passes
-- the auth-resolved tenant, so the definer-rights writes stay tenant-scoped.

-- ── Normalisation helpers ────────────────────────────────────────────────────
-- Cheap, deterministic (IMMUTABLE) text normalisers shared by the duplicate
-- finders. Left PUBLIC-executable: they are pure and leak nothing.

-- Company names: lower-case, strip punctuation, collapse whitespace, then strip
-- legal suffixes — but ONLY from the END, and repeatedly. Suffixes are a trailing
-- decoration ("Acme Inc.", "Acme Sanayi Ticaret Ltd Sti"); stripping them mid-string
-- (the old \y…\y global pass) mangled names like "Corp Solutions". The anchored
-- (\s+token)+\s*$ group peels every trailing suffix token in one match.
-- "Acme Inc." / "ACME, LLC" / "Acme Sanayi Ticaret A.S." all collapse to "acme".
CREATE OR REPLACE FUNCTION crm_norm_name(v TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT btrim(regexp_replace(
    btrim(regexp_replace(
      regexp_replace(lower(coalesce(v, '')), '[.,\-_/&()''"]+', ' ', 'g'),
      '\s+', ' ', 'g'
    )),
    '(\s+(inc|llc|ltd|sti|limited|corp|corporation|company|co|gmbh|sa|as|a s|san|tic|sanayi|ticaret|holding|group|grup))+\s*$',
    '', 'g'
  ));
$$;

-- Person names: same lower/strip/collapse, but NEVER strip legal suffixes — a person
-- surnamed "As", "San" or "Co" must keep every token. Used by the contact duplicate
-- finder for name matching.
CREATE OR REPLACE FUNCTION crm_norm_person(v TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT btrim(regexp_replace(
    regexp_replace(lower(coalesce(v, '')), '[.,\-_/&()''"]+', ' ', 'g'),
    '\s+', ' ', 'g'
  ));
$$;

-- Extract a bare host from a URL-ish string: drop scheme, "www.", path/query, lower.
-- "https://www.acme.com/x" → "acme.com".
CREATE OR REPLACE FUNCTION crm_norm_domain(v TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT btrim(regexp_replace(
    regexp_replace(lower(coalesce(v, '')), '^\s*https?://', '', 'i'),
    '^(www\.)?([^/?#\s]*).*$', '\2'
  ));
$$;

-- Digits only, then normalise the TR trunk/country prefix so "+90 5xx…", "0 5xx…" and
-- bare "5xx…" collapse to the same national number: strip a leading "90" country code,
-- then a single leading "0" trunk (simple TR-focused rule). Callers still ignore
-- matches shorter than 7 digits (false-positive guard).
CREATE OR REPLACE FUNCTION crm_norm_phone(v TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  -- digits-only, then strip international 00 prefix, TR country code 90, trunk 0:
  -- '+90 5xx', '0090 5xx', '05xx' and '5xx' all collapse to the same key.
  SELECT regexp_replace(
           regexp_replace(
             regexp_replace(
               regexp_replace(coalesce(v, ''), '\D', '', 'g'),
               '^00', ''
             ),
             '^90', ''
           ),
           '^0', ''
         );
$$;

-- ── crm_merge_log ────────────────────────────────────────────────────────────
-- Append-only record of a completed merge. field_choices = the per-field winner
-- map the user picked; moved_counts = how many children moved per table. Immutable
-- by design: only the SECURITY DEFINER merge RPCs (running as owner) write it, and
-- there are NO update/delete RLS policies — the audit trail cannot be rewritten.
CREATE TABLE crm_merge_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity_type   TEXT NOT NULL CHECK (entity_type IN ('company', 'contact')),
  source_id     UUID NOT NULL,
  target_id     UUID NOT NULL,
  field_choices JSONB NOT NULL DEFAULT '{}',
  moved_counts  JSONB NOT NULL DEFAULT '{}',
  performed_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT crm_merge_log_distinct CHECK (source_id <> target_id)
);

CREATE INDEX idx_crm_merge_log_tenant_created ON crm_merge_log (tenant_id, created_at DESC);
CREATE INDEX idx_crm_merge_log_target ON crm_merge_log (tenant_id, entity_type, target_id);

ALTER TABLE crm_merge_log ENABLE ROW LEVEL SECURITY;

-- Read: own tenant (or superadmin cross-tenant). No write policies on purpose —
-- writes flow exclusively through the definer-rights merge RPCs.
CREATE POLICY "crm_merge_log_select" ON crm_merge_log
  FOR SELECT USING (
    tenant_id = get_user_tenant_id()
    OR is_superadmin()
  );

COMMENT ON TABLE crm_merge_log IS
  'Append-only audit of company/contact merges. Written only by merge_companies/merge_contacts (SECURITY DEFINER). Immutable: no UPDATE/DELETE RLS policies.';

-- Tenant-consistency fence (114/121 pattern): source_id/target_id must resolve to a
-- row of the declared entity_type inside NEW.tenant_id (defense in depth atop the RPC).
CREATE OR REPLACE FUNCTION crm_merge_log_assert_tenant_consistency()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.entity_type = 'company' THEN
    IF NOT EXISTS (SELECT 1 FROM public.companies WHERE id = NEW.source_id AND tenant_id = NEW.tenant_id)
       OR NOT EXISTS (SELECT 1 FROM public.companies WHERE id = NEW.target_id AND tenant_id = NEW.tenant_id) THEN
      RAISE EXCEPTION 'crm_merge_log: company source/target must belong to tenant %', NEW.tenant_id;
    END IF;
  ELSIF NEW.entity_type = 'contact' THEN
    IF NOT EXISTS (SELECT 1 FROM public.contacts WHERE id = NEW.source_id AND tenant_id = NEW.tenant_id)
       OR NOT EXISTS (SELECT 1 FROM public.contacts WHERE id = NEW.target_id AND tenant_id = NEW.tenant_id) THEN
      RAISE EXCEPTION 'crm_merge_log: contact source/target must belong to tenant %', NEW.tenant_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS crm_merge_log_tenant_consistency ON crm_merge_log;
CREATE TRIGGER crm_merge_log_tenant_consistency
  BEFORE INSERT ON crm_merge_log
  FOR EACH ROW EXECUTE FUNCTION crm_merge_log_assert_tenant_consistency();

-- Enforce append-only at the grant layer too (repo ledger pattern, 062/069/072): no
-- role may write DML directly. The merge RPCs are SECURITY DEFINER and run as the table
-- OWNER, which bypasses these REVOKEs, so their INSERTs still succeed — but service_role
-- (and anything else) cannot UPDATE/DELETE/INSERT the audit trail out of band.
REVOKE INSERT, UPDATE, DELETE ON crm_merge_log FROM PUBLIC, anon, authenticated, service_role;

-- ── Soft-merge marker columns (ADDITIVE) ─────────────────────────────────────
-- merged_into_id points a disabled source at the record it was merged into; NULL = a
-- live record. Added here (IF NOT EXISTS, additive) so the merge RPCs below can write
-- it and the finders can exclude already-merged rows. Ordering notes:
--   * self-FK ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED. "NULL = live" is an
--     invariant the whole feature relies on, so the pointer must NEVER silently clear:
--     the old ON DELETE SET NULL would resurrect a merged (dead) source back to "live"
--     if its merge target were later hard-deleted. NO ACTION rejects a standalone delete
--     of a target that still has sources pointing at it — but INITIALLY DEFERRED checks
--     the constraint only at COMMIT, so a tenant CASCADE (which removes source AND target
--     in the same transaction) still succeeds: both rows are gone by commit, nothing
--     dangles. (Postgres can DEFER NO ACTION but NOT RESTRICT, so NO ACTION is required
--     to keep the tenant-cascade delete working.)
--   * E9/137 adds companies.archived_at and every list path filters archived_at IS
--     NULL. Both 136 and 137 land in the same run, so by the time a merge RPC is
--     CALLED archived_at exists too — that write below stays conditional (works alone).
ALTER TABLE companies ADD COLUMN IF NOT EXISTS merged_into_id UUID;
ALTER TABLE contacts  ADD COLUMN IF NOT EXISTS merged_into_id UUID;

-- Named + idempotent self-FKs. DROP IF EXISTS covers BOTH the auto-generated inline name
-- (…_fkey, from an earlier apply that used an inline REFERENCES) AND our named constraint,
-- so re-applying this migration is a clean no-op rather than a "constraint already exists".
ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_merged_into_id_fkey;
ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_merged_into_id_fk;
ALTER TABLE companies ADD CONSTRAINT companies_merged_into_id_fk
  FOREIGN KEY (merged_into_id) REFERENCES companies(id)
  ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_merged_into_id_fkey;
ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_merged_into_id_fk;
ALTER TABLE contacts ADD CONSTRAINT contacts_merged_into_id_fk
  FOREIGN KEY (merged_into_id) REFERENCES contacts(id)
  ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

-- ── Duplicate finders ────────────────────────────────────────────────────────
-- Both are tenant-scoped, normalise before comparing, exclude the record itself and
-- any already-merged-away source (merged_into_id NOT NULL, plus the legacy notes
-- markers for belt-and-suspenders), cap at 5.

CREATE OR REPLACE FUNCTION find_duplicate_companies(
  p_tenant_id UUID,
  p_company_id UUID
)
RETURNS TABLE (
  id            UUID,
  name          TEXT,
  website       TEXT,
  company_phone TEXT,
  stage         TEXT,
  contact_count INTEGER,
  match_reason  TEXT
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH tgt AS (
    SELECT crm_norm_name(name)          AS nname,
           crm_norm_domain(website)     AS ndomain,
           crm_norm_phone(company_phone) AS nphone
      FROM companies
     WHERE id = p_company_id AND tenant_id = p_tenant_id
  )
  SELECT c.id, c.name, c.website, c.company_phone, c.stage, c.contact_count,
         CASE
           WHEN t.nname <> ''   AND crm_norm_name(c.name)           = t.nname   THEN 'name'
           WHEN t.ndomain <> '' AND crm_norm_domain(c.website)      = t.ndomain THEN 'website'
           ELSE 'phone'
         END AS match_reason
    FROM companies c CROSS JOIN tgt t
   WHERE c.tenant_id = p_tenant_id
     AND c.id <> p_company_id
     AND c.merged_into_id IS NULL
     AND COALESCE(c.internal_notes, '') NOT LIKE '%[merged into %'
     AND (
          (t.nname   <> ''            AND crm_norm_name(c.name)            = t.nname)
       OR (t.ndomain <> ''            AND crm_norm_domain(c.website)       = t.ndomain)
       OR (length(t.nphone) >= 7      AND crm_norm_phone(c.company_phone)  = t.nphone)
     )
   ORDER BY match_reason, c.name
   LIMIT 5;
$$;

-- Contact duplicates are scoped to the SAME company: merge_contacts only permits
-- same-company merges (keeps the tasks/activities tenant-consistency triggers happy),
-- so surfacing a cross-company "duplicate" would offer a merge that must fail.
CREATE OR REPLACE FUNCTION find_duplicate_contacts(
  p_tenant_id UUID,
  p_contact_id UUID
)
RETURNS TABLE (
  id         UUID,
  first_name TEXT,
  last_name  TEXT,
  email      TEXT,
  phone_e164 TEXT,
  title      TEXT,
  is_primary BOOLEAN,
  match_reason TEXT
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH tgt AS (
    SELECT company_id,
           lower(btrim(coalesce(email, '')))                                    AS nemail,
           crm_norm_phone(phone_e164)                                           AS nphone,
           crm_norm_person(coalesce(first_name, '') || ' ' || coalesce(last_name, '')) AS nname
      FROM contacts
     WHERE id = p_contact_id AND tenant_id = p_tenant_id
  )
  SELECT c.id, c.first_name, c.last_name, c.email, c.phone_e164, c.title, c.is_primary,
         CASE
           WHEN t.nemail <> ''       AND lower(btrim(coalesce(c.email, ''))) = t.nemail THEN 'email'
           WHEN length(t.nphone) >= 7 AND crm_norm_phone(c.phone_e164)       = t.nphone THEN 'phone'
           ELSE 'name'
         END AS match_reason
    FROM contacts c CROSS JOIN tgt t
   WHERE c.tenant_id = p_tenant_id
     AND c.company_id = t.company_id
     AND c.id <> p_contact_id
     AND c.merged_into_id IS NULL
     -- notes is nullable (default '[]'); COALESCE keeps NULL-notes contacts (the common
     -- case) IN the result — `NULL @> …` is NULL, which would silently drop the row.
     AND NOT (COALESCE(c.notes, '[]'::jsonb) @> '[{"type": "merge"}]'::jsonb)
     AND (
          (t.nemail <> ''            AND lower(btrim(coalesce(c.email, ''))) = t.nemail)
       OR (length(t.nphone) >= 7     AND crm_norm_phone(c.phone_e164)       = t.nphone)
       OR (t.nname <> ''             AND crm_norm_person(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')) = t.nname)
     )
   ORDER BY match_reason, c.first_name
   LIMIT 5;
$$;

-- ── merge_companies ──────────────────────────────────────────────────────────
-- Single transaction (a plpgsql body IS one tx): apply the per-field winners onto
-- the TARGET, move every child (contacts → tasks → activities → leads/deals guarded)
-- from source to target, disable the source WITHOUT data loss (archive if the column
-- exists, else stamp an internal_notes marker), then write crm_merge_log. Any failure
-- rolls the whole thing back — no partial merge.
--
-- Child-move order matters: contacts move FIRST so that when tasks.company_id is
-- repointed, tasks_tenant_consistency (115/120) still finds each task's contact inside
-- the (now target) company. p_field_winners = { <column>: 'source' | 'target' };
-- absent / 'target' keeps the target's value.
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

  -- Lock both rows in a stable (id) order to avoid deadlocks between concurrent merges.
  PERFORM 1 FROM companies
   WHERE tenant_id = p_tenant_id AND id IN (p_source_id, p_target_id)
   ORDER BY id FOR UPDATE;

  SELECT * INTO v_source FROM companies WHERE id = p_source_id AND tenant_id = p_tenant_id;
  SELECT * INTO v_target FROM companies WHERE id = p_target_id AND tenant_id = p_tenant_id;

  IF v_source.id IS NULL THEN RAISE EXCEPTION 'merge: source company not found'; END IF;
  IF v_target.id IS NULL THEN RAISE EXCEPTION 'merge: target company not found'; END IF;

  -- Post-lock re-check (concurrent A→B while this call does A→C). merged_into_id was
  -- read INSIDE the row lock, so whichever merge grabbed the lock first stamps it and
  -- the loser aborts here. Machine-coded messages → the route maps them to HTTP 409.
  IF v_source.merged_into_id IS NOT NULL THEN
    RAISE EXCEPTION 'source_already_merged' USING ERRCODE = 'check_violation';
  END IF;
  IF v_target.merged_into_id IS NOT NULL THEN
    RAISE EXCEPTION 'target_already_merged' USING ERRCODE = 'check_violation';
  END IF;

  -- 1) Apply field winners onto the target. stage/owner/coords/custom deliberately
  --    excluded (stage carries terminal-state semantics; never flipped by a merge).
  UPDATE companies SET
    name              = CASE WHEN v_fw->>'name'              = 'source' THEN v_source.name              ELSE v_target.name              END,
    website           = CASE WHEN v_fw->>'website'           = 'source' THEN v_source.website           ELSE v_target.website           END,
    location          = CASE WHEN v_fw->>'location'          = 'source' THEN v_source.location          ELSE v_target.location          END,
    industry          = CASE WHEN v_fw->>'industry'          = 'source' THEN v_source.industry          ELSE v_target.industry          END,
    employee_size     = CASE WHEN v_fw->>'employee_size'     = 'source' THEN v_source.employee_size     ELSE v_target.employee_size     END,
    company_summary   = CASE WHEN v_fw->>'company_summary'   = 'source' THEN v_source.company_summary   ELSE v_target.company_summary   END,
    internal_notes    = CASE WHEN v_fw->>'internal_notes'    = 'source' THEN v_source.internal_notes    ELSE v_target.internal_notes    END,
    next_step         = CASE WHEN v_fw->>'next_step'         = 'source' THEN v_source.next_step         ELSE v_target.next_step         END,
    linkedin          = CASE WHEN v_fw->>'linkedin'          = 'source' THEN v_source.linkedin          ELSE v_target.linkedin          END,
    company_phone     = CASE WHEN v_fw->>'company_phone'     = 'source' THEN v_source.company_phone     ELSE v_target.company_phone     END,
    company_email     = CASE WHEN v_fw->>'company_email'     = 'source' THEN v_source.company_email     ELSE v_target.company_email     END,
    email_status      = CASE WHEN v_fw->>'email_status'      = 'source' THEN v_source.email_status      ELSE v_target.email_status      END,
    fit_score         = CASE WHEN v_fw->>'fit_score'         = 'source' THEN v_source.fit_score         ELSE v_target.fit_score         END,
    product_services  = CASE WHEN v_fw->>'product_services'  = 'source' THEN v_source.product_services  ELSE v_target.product_services  END,
    product_portfolio = CASE WHEN v_fw->>'product_portfolio' = 'source' THEN v_source.product_portfolio ELSE v_target.product_portfolio END
  WHERE id = p_target_id AND tenant_id = p_tenant_id;

  -- 2) Move children. Contacts FIRST (see header). The contacts trigger recomputes
  --    contact_count for both companies, so we never touch that column by hand.
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

  -- leads (121) / deals (133) may not exist on a partial apply — guard each.
  IF to_regclass('public.leads') IS NOT NULL THEN
    EXECUTE 'UPDATE leads SET company_id = $1 WHERE company_id = $2 AND tenant_id = $3'
      USING p_target_id, p_source_id, p_tenant_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_moved := v_moved || jsonb_build_object('leads', v_n);
  END IF;

  IF to_regclass('public.deals') IS NOT NULL THEN
    -- Explicitly tenant-fence the definer-rights write (deals.tenant_id from 133).
    EXECUTE 'UPDATE deals SET company_id = $1 WHERE company_id = $2 AND tenant_id = $3'
      USING p_target_id, p_source_id, p_tenant_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_moved := v_moved || jsonb_build_object('deals', v_n);
  END IF;

  -- 3) Disable the source WITHOUT deleting it (avoids cascade wiping the just-moved
  --    children). Always stamp an internal_notes marker; also set archived_at when the
  --    column exists (137/E9). Never change the source stage.
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

  -- 4) Audit.
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

-- ── merge_contacts ───────────────────────────────────────────────────────────
-- Same-company only (see find_duplicate_contacts). Apply winners onto target, repoint
-- children (activities/tasks/leads/deals/deal_contacts), disable the source contact
-- (demote from primary + notes marker; contacts have no archive column), write the log.
CREATE OR REPLACE FUNCTION merge_contacts(
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
  v_source contacts%ROWTYPE;
  v_target contacts%ROWTYPE;
  v_fw     JSONB   := COALESCE(p_field_winners, '{}'::jsonb);
  v_moved  JSONB   := '{}'::jsonb;
  v_n      INTEGER;
  v_log_id UUID;
BEGIN
  IF p_source_id = p_target_id THEN
    RAISE EXCEPTION 'merge: source and target must differ' USING ERRCODE = 'check_violation';
  END IF;

  PERFORM 1 FROM contacts
   WHERE tenant_id = p_tenant_id AND id IN (p_source_id, p_target_id)
   ORDER BY id FOR UPDATE;

  SELECT * INTO v_source FROM contacts WHERE id = p_source_id AND tenant_id = p_tenant_id;
  SELECT * INTO v_target FROM contacts WHERE id = p_target_id AND tenant_id = p_tenant_id;

  IF v_source.id IS NULL THEN RAISE EXCEPTION 'merge: source contact not found'; END IF;
  IF v_target.id IS NULL THEN RAISE EXCEPTION 'merge: target contact not found'; END IF;

  -- Post-lock re-check (concurrent merge stamped either row while we waited for the
  -- lock). Machine-coded messages → the route maps them to HTTP 409.
  IF v_source.merged_into_id IS NOT NULL THEN
    RAISE EXCEPTION 'source_already_merged' USING ERRCODE = 'check_violation';
  END IF;
  IF v_target.merged_into_id IS NOT NULL THEN
    RAISE EXCEPTION 'target_already_merged' USING ERRCODE = 'check_violation';
  END IF;

  IF v_source.company_id <> v_target.company_id THEN
    RAISE EXCEPTION 'merge: contacts must belong to the same company' USING ERRCODE = 'check_violation';
  END IF;

  -- 1) Field winners onto target.
  UPDATE contacts SET
    first_name = CASE WHEN v_fw->>'first_name' = 'source' THEN v_source.first_name ELSE v_target.first_name END,
    last_name  = CASE WHEN v_fw->>'last_name'  = 'source' THEN v_source.last_name  ELSE v_target.last_name  END,
    title      = CASE WHEN v_fw->>'title'      = 'source' THEN v_source.title      ELSE v_target.title      END,
    email      = CASE WHEN v_fw->>'email'      = 'source' THEN v_source.email      ELSE v_target.email      END,
    phone_e164 = CASE WHEN v_fw->>'phone_e164' = 'source' THEN v_source.phone_e164 ELSE v_target.phone_e164 END,
    country    = CASE WHEN v_fw->>'country'    = 'source' THEN v_source.country    ELSE v_target.country    END,
    seniority  = CASE WHEN v_fw->>'seniority'  = 'source' THEN v_source.seniority  ELSE v_target.seniority  END,
    department = CASE WHEN v_fw->>'department' = 'source' THEN v_source.department ELSE v_target.department END,
    linkedin   = CASE WHEN v_fw->>'linkedin'   = 'source' THEN v_source.linkedin   ELSE v_target.linkedin   END
  WHERE id = p_target_id AND tenant_id = p_tenant_id;

  -- 2) Repoint children source → target. Same-company guarantee keeps the tasks
  --    tenant-consistency trigger satisfied (target contact is in the task's company).
  UPDATE activities SET contact_id = p_target_id
   WHERE contact_id = p_source_id AND tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_moved := v_moved || jsonb_build_object('activities', v_n);

  UPDATE tasks SET contact_id = p_target_id
   WHERE contact_id = p_source_id AND tenant_id = p_tenant_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_moved := v_moved || jsonb_build_object('tasks', v_n);

  IF to_regclass('public.leads') IS NOT NULL THEN
    EXECUTE 'UPDATE leads SET contact_id = $1 WHERE contact_id = $2 AND tenant_id = $3'
      USING p_target_id, p_source_id, p_tenant_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_moved := v_moved || jsonb_build_object('leads', v_n);
  END IF;

  IF to_regclass('public.deals') IS NOT NULL THEN
    -- Explicitly tenant-fence the definer-rights write (deals.tenant_id from 133).
    EXECUTE 'UPDATE deals SET contact_id = $1 WHERE contact_id = $2 AND tenant_id = $3'
      USING p_target_id, p_source_id, p_tenant_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_moved := v_moved || jsonb_build_object('deals', v_n);
  END IF;

  IF to_regclass('public.deal_contacts') IS NOT NULL THEN
    -- Drop rows that would collide on (deal_id, contact_id) after the repoint (both
    -- contacts already on the same deal), then move the survivors. deal_contacts.tenant_id
    -- exists (133); every write is tenant-fenced, and the collision-DELETE fences BOTH
    -- sides to p_tenant_id so a cross-tenant dc2 can never suppress a legitimate move.
    EXECUTE 'DELETE FROM deal_contacts dc WHERE dc.contact_id = $1 AND dc.tenant_id = $3 AND EXISTS (
               SELECT 1 FROM deal_contacts dc2 WHERE dc2.deal_id = dc.deal_id AND dc2.contact_id = $2 AND dc2.tenant_id = $3)'
      USING p_source_id, p_target_id, p_tenant_id;
    EXECUTE 'UPDATE deal_contacts SET contact_id = $1 WHERE contact_id = $2 AND tenant_id = $3'
      USING p_target_id, p_source_id, p_tenant_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_moved := v_moved || jsonb_build_object('deal_contacts', v_n);
  END IF;

  -- 3) Disable the source contact without data loss: demote from primary + notes marker.
  UPDATE contacts
     SET merged_into_id = p_target_id,
         is_primary = false,
         notes = COALESCE(notes, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
                   'type', 'merge', 'into', p_target_id::text, 'at', now()))
   WHERE id = p_source_id AND tenant_id = p_tenant_id;

  -- 4) Audit.
  INSERT INTO crm_merge_log (tenant_id, entity_type, source_id, target_id, field_choices, moved_counts, performed_by)
  VALUES (p_tenant_id, 'contact', p_source_id, p_target_id, v_fw, v_moved, p_performed_by)
  RETURNING id INTO v_log_id;

  RETURN jsonb_build_object(
    'merge_log_id', v_log_id,
    'entity_type',  'contact',
    'source_id',    p_source_id,
    'target_id',    p_target_id,
    'moved_counts', v_moved
  );
END;
$$;

-- ── Lock the RPCs to service_role (115/119 posture) ──────────────────────────
REVOKE ALL ON FUNCTION find_duplicate_companies(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION find_duplicate_companies(UUID, UUID) TO service_role;

REVOKE ALL ON FUNCTION find_duplicate_contacts(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION find_duplicate_contacts(UUID, UUID) TO service_role;

REVOKE ALL ON FUNCTION merge_companies(UUID, UUID, UUID, JSONB, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION merge_companies(UUID, UUID, UUID, JSONB, UUID) TO service_role;

REVOKE ALL ON FUNCTION merge_contacts(UUID, UUID, UUID, JSONB, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION merge_contacts(UUID, UUID, UUID, JSONB, UUID) TO service_role;
