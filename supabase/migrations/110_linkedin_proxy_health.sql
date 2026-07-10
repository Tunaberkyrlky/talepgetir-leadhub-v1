-- ==========================================
-- 110_linkedin_proxy_health.sql
-- TG-LinkedIn P2 — proxy health lifecycle + staged provider reconcile (sync).
-- Design: Tg-LinkedIn/04_STATIC_PROXY_POOL.md §4a (staged sync, P1.8) / §4d (health lifecycle,
-- P1.14/P1.15/P1.16) + §9 review rows P1.8/P1.14/P1.15/P1.16.
--
-- Builds on mig 106/107 (import+assign, generation gate, burned-IP denylist), 108 (pool + claim),
-- 109 (assignment-scoped send-lease, lease-aware linkedin_burn_proxy). Adds two atomic RPCs:
--
--   * linkedin_apply_proxy_health(tenant, account, target_status, classifier, expected_proxy?) — the
--     ONE txn that applies a hard-classifier account transition AND (for a static_required account
--     whose CURRENT assignment still matches expected_proxy — C1 fence — entering a
--     RESTRICTED/CHALLENGED state) retires its proxy binding, bumps endpoint_generation, moves the
--     proxy to reputation_state='quarantined' (NOT burned — P1.15/P1.16: a restriction may not be
--     IP-sourced, and re-logging from a fresh IP raises identity-discontinuity, so we quarantine +
--     require explicit recovery, we do NOT auto-reassign), and cancels the account's queued
--     linkedin:* jobs (same set as cancelPendingAccountJobs). NEEDS_REAUTH is a session (cookie)
--     failure, not an IP failure: it cancels queued jobs but never touches the proxy. Idempotent:
--     a repeat call with the SAME already-applied status is a no-op (no double retire / double
--     bump). Lock-ordered: the proxy retire takes the SAME proxy-keyed advisory lock (+FOR UPDATE)
--     as linkedin_burn_proxy / linkedin_acquire_send_lease, in the SAME relative order. The retire
--     runs UNCONDITIONALLY once a hard classifier lands — even under a live send-lease: the account
--     is already RESTRICTED/CHALLENGED so no NEW send starts, retiring the DB row does not affect the
--     in-flight socket, and the holder's token-matched release then no-ops. (Deferring instead left a
--     hard-classified account's proxy clean+assigned forever, since the idempotency guard + the TS
--     early-return blocked every re-apply, so a later re-validate could resume sends on the flagged
--     IP.) lease_was_live is returned for observability only. NOTE: linkedin_burn_proxy's live-lease
--     REFUSAL (mig 109) is a PERMANENT burn and correctly stays deferral-based — untouched here.
--
--     BURN vs QUARANTINE (chosen policy): this RPC never denylists an exit_ip. Burning an IP into
--     the permanent linkedin_burned_exit_ips list is a heavier, explicit escalation that stays on
--     the existing lease-aware linkedin_burn_proxy RPC (mig 109). A health-driven hard state only
--     QUARANTINES (recoverable) per P1.15/P1.16.
--
--   * linkedin_proxy_sync_apply(provider, owner_tenant, snapshot, complete, error) — the ONE txn
--     that reconciles a provider snapshot with §4a's non-negotiable invariants: NOTHING
--     destructive happens on an incomplete run (fetch error / rate-limit → complete=false → only
--     an audit row); on a COMPLETE snapshot, matched rows get provider_health / plan_expires_at /
--     last_seen_sync refreshed and their miss-counter reset, and unmatched rows have their
--     consecutive_sync_misses bumped — a proxy is flagged provider-gone (provider_health
--     ='unhealthy' + provider_gone_at) ONLY after N=3 consecutive complete-run misses, NEVER on a
--     single miss. Sync NEVER touches reputation_state or assignments and NEVER inserts a new
--     proxy (creds/exit_ip only enter via the server-side echo-verified import path).
--
-- Atomic mutations go through SECURITY DEFINER RPCs (Supabase can't hold BEGIN/COMMIT across
-- client calls). Deny-all RLS; service-role only. Additive + re-runnable.
-- ==========================================

-- ── Sync bookkeeping: miss counter + provider-gone marker on the proxy row ────────
-- consecutive_sync_misses counts COMPLETE-run misses only (reset to 0 on any match). provider_gone_at
-- is stamped once the N=3 threshold is crossed (distinct from plan_expires_at, which is plan expiry).
ALTER TABLE linkedin_proxies
  ADD COLUMN IF NOT EXISTS consecutive_sync_misses INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS provider_gone_at        TIMESTAMPTZ;

-- ── Sync run audit (one row per reconcile attempt; observability + the §4a "staged first" trail) ──
CREATE TABLE IF NOT EXISTS linkedin_proxy_sync_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider        TEXT NOT NULL,
  owner_tenant_id UUID,                       -- NULL = global-pool scope
  status          TEXT NOT NULL CHECK (status IN ('complete','incomplete')),
  staged_count    INTEGER NOT NULL DEFAULT 0, -- rows in the provider snapshot the handler assembled
  matched_count   INTEGER NOT NULL DEFAULT 0, -- staged rows that matched an existing proxy
  unknown_count   INTEGER NOT NULL DEFAULT 0, -- staged rows with no imported proxy (operator visibility)
  missed_count    INTEGER NOT NULL DEFAULT 0, -- existing proxies absent from a COMPLETE snapshot
  gone_count      INTEGER NOT NULL DEFAULT 0, -- proxies that crossed the N-miss threshold THIS run
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS linkedin_proxy_sync_runs_provider_created
  ON linkedin_proxy_sync_runs(provider, created_at DESC);

ALTER TABLE linkedin_proxy_sync_runs ENABLE ROW LEVEL SECURITY;

-- ── C6 (codex P2.6): at-most-one QUEUED proxy-sync successor per tenant, enforced atomically ──
-- The self-healing loop dedups on status='queued' (a running job must not suppress its successor).
-- A read→insert race between two would-be schedulers could still double-enqueue; this partial unique
-- index makes the second insert fail with 23505, which ensureProxySyncLoop / the /sync route swallow
-- as already-queued. Partial (queued + this type only) so it never constrains running/finished rows
-- or any other job type.
CREATE UNIQUE INDEX IF NOT EXISTS research_jobs_one_queued_proxy_sync_per_tenant
  ON research_jobs (tenant_id, type)
  WHERE status = 'queued' AND type = 'linkedin:proxy-sync';

-- ── RPC: apply a health transition + (static) proxy lifecycle, atomically ─────────
-- p_target_status is the account status resolved by the TS statusForWrite() seam (403→RESTRICTED,
-- 999→CHALLENGED, 401→NEEDS_REAUTH) so the classifier→status mapping stays in ONE place; the RPC
-- decides hardness/retire from the resolved status value. p_classifier is carried for the cancel
-- reason + quarantine audit only.
-- C1 (codex P1.1): the OPTIONAL p_expected_proxy fences the proxy-lifecycle block to the proxy the
-- caller last validated against (applyWriteHealth passes account.last_validated_proxy_id). When it is
-- NON-NULL and the account's CURRENT active assignment points at a DIFFERENT proxy, the assignment
-- moved since the caller's snapshot (a re-import/claim/recovery landed) and this hard classifier is
-- STALE for the new proxy — so we SKIP the retire/quarantine/bump entirely (the status transition +
-- queued-job cancel still land) and return proxy_skipped:'assignment_changed'. NULL (back-compat)
-- behaves exactly as before (no fence).
CREATE OR REPLACE FUNCTION linkedin_apply_proxy_health(
  p_tenant         UUID,
  p_account        UUID,
  p_target_status  TEXT,
  p_classifier     TEXT DEFAULT NULL,
  p_expected_proxy UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status    TEXT;
  v_mode      TEXT;
  v_changed   BOOLEAN := FALSE;
  v_proxy_id  UUID;
  v_lease     TIMESTAMPTZ;
  v_repu      TEXT;
  v_new_gen   INTEGER;
  v_retired   BOOLEAN := FALSE;
  v_lease_live BOOLEAN := FALSE;
  v_quarant   BOOLEAN := FALSE;
  v_canceled  INTEGER := 0;
  v_skipped   TEXT := NULL;   -- C1: set to 'assignment_changed' when the fence skips the lifecycle
BEGIN
  IF p_target_status IS NULL OR p_target_status NOT IN ('RESTRICTED','CHALLENGED','NEEDS_REAUTH') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_target_status');
  END IF;

  -- Lock the account row, tenant-scoped. Missing/foreign → reject (no cross-tenant health apply).
  SELECT status, proxy_mode INTO v_status, v_mode
    FROM linkedin_accounts WHERE id = p_account AND tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'account_not_found');
  END IF;

  -- Never lift an operator PAUSE (mirrors applyWriteHealth's PAUSE guard).
  IF v_status = 'PAUSED' THEN
    RETURN jsonb_build_object('ok', true, 'status', 'PAUSED', 'changed', false, 'paused_not_overridden', true);
  END IF;

  -- Idempotent: already in the target state → no status change AND no re-retire/re-bump.
  IF v_status = p_target_status THEN
    RETURN jsonb_build_object('ok', true, 'status', v_status, 'changed', false, 'idempotent', true);
  END IF;

  -- Apply the transition (the AND status <> 'PAUSED' keeps a concurrent PAUSE winning).
  UPDATE linkedin_accounts SET status = p_target_status
    WHERE id = p_account AND tenant_id = p_tenant AND status <> 'PAUSED';
  IF NOT FOUND THEN
    -- A PAUSE landed between our lock read and here (shouldn't under the row lock, but fail-safe).
    RETURN jsonb_build_object('ok', true, 'status', 'PAUSED', 'changed', false, 'paused_not_overridden', true);
  END IF;
  v_changed := TRUE;

  -- Auto-pause queue drain: cancel this account's still-QUEUED linkedin:* jobs (same set as
  -- cancelPendingAccountJobs). Fires for every hard state (incl. NEEDS_REAUTH).
  UPDATE research_jobs
    SET status = 'canceled', finished_at = now(),
        error = left('auto-paused: health:' || COALESCE(p_classifier, p_target_status), 2000)
    WHERE tenant_id = p_tenant AND status = 'queued' AND type LIKE 'linkedin:%'
      AND payload->>'account_id' = p_account::text;
  GET DIAGNOSTICS v_canceled = ROW_COUNT;

  -- Proxy lifecycle ONLY for a static_required account entering a hard RESTRICT state. NEEDS_REAUTH
  -- is a cookie/session failure, not an IP failure → the proxy is left untouched (P1.16 split).
  IF p_target_status IN ('RESTRICTED','CHALLENGED') AND v_mode = 'static_required' THEN
    SELECT proxy_id INTO v_proxy_id FROM linkedin_proxy_assignments
      WHERE account_id = p_account AND tenant_id = p_tenant AND released_at IS NULL;
    -- C1 fence: if the caller pinned an expected proxy and the CURRENT assignment has moved off it,
    -- this classifier is stale for the new proxy → skip the whole lifecycle (status + cancel already
    -- landed above). NULL p_expected_proxy = no fence (back-compat).
    IF p_expected_proxy IS NOT NULL AND v_proxy_id IS DISTINCT FROM p_expected_proxy THEN
      v_skipped := 'assignment_changed';
    ELSIF v_proxy_id IS NOT NULL THEN
      -- SAME advisory key + SAME order (lock, THEN proxy FOR UPDATE) as linkedin_burn_proxy /
      -- linkedin_acquire_send_lease, so a concurrent burn/acquire on this proxy can't interleave.
      PERFORM pg_advisory_xact_lock(hashtextextended(v_proxy_id::text, 42));
      SELECT reputation_state INTO v_repu FROM linkedin_proxies WHERE id = v_proxy_id FOR UPDATE;

      -- Re-read the assignment's lease under the lock, for OBSERVABILITY only (lease_was_live).
      -- Unlike a permanent burn (linkedin_burn_proxy stays deferral-based), the health retire runs
      -- UNCONDITIONALLY — even under a live send-lease. The account is already entering a hard state
      -- so no NEW send starts; retiring the DB row does not touch the in-flight socket; and the lease
      -- holder's token-matched release (linkedin_release_send_lease) then no-ops harmlessly on the
      -- already-released assignment. Deferring instead left the proxy clean+assigned forever (the
      -- idempotency guard + TS early-return blocked every re-apply), so a later successful re-validate
      -- could resume sends on the flagged IP — the exact hole this fix closes.
      SELECT lease_expires_at INTO v_lease FROM linkedin_proxy_assignments
        WHERE account_id = p_account AND tenant_id = p_tenant AND released_at IS NULL;
      v_lease_live := (v_lease IS NOT NULL AND v_lease > now());

      UPDATE linkedin_proxy_assignments
        SET released_at = now(), lease_token = NULL, lease_expires_at = NULL, lease_job_id = NULL
        WHERE account_id = p_account AND tenant_id = p_tenant AND released_at IS NULL;
      UPDATE linkedin_proxies
        SET endpoint_generation = endpoint_generation + 1,
            -- quarantine (recoverable) — NOT burned. A burned proxy stays burned.
            reputation_state = CASE WHEN reputation_state = 'burned' THEN 'burned' ELSE 'quarantined' END,
            updated_at = now()
        WHERE id = v_proxy_id
        RETURNING endpoint_generation, reputation_state INTO v_new_gen, v_repu;
      -- Clear the account's validated pointers so no stale send-gate can open on the old IP.
      UPDATE linkedin_accounts
        SET last_validated_proxy_generation = NULL, last_validated_proxy_id = NULL
        WHERE id = p_account AND tenant_id = p_tenant;
      v_retired := TRUE;
      v_quarant := (v_repu = 'quarantined');
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'status', p_target_status, 'changed', v_changed,
    'jobs_canceled', v_canceled,
    'proxy_id', v_proxy_id,
    'proxy_retired', v_retired, 'quarantined', v_quarant,
    'proxy_skipped', v_skipped,   -- C1: 'assignment_changed' when the fence skipped the lifecycle
    'lease_was_live', v_lease_live,
    'new_generation', v_new_gen
  );
END;
$$;

-- ── RPC: reconcile a provider snapshot (staged, non-destructive on incomplete) ────
-- p_snapshot is a JSON array of the FULL provider listing the handler assembled IN MEMORY (only
-- after every page fetched cleanly). Element shape (extra keys ignored):
--   { "ext_id": text, "ip": text|null, "provider_health": 'healthy'|'unhealthy'|null, "plan_expires_at": tstz|null }
-- C7: a row matches an entry by ext_id OR by exit_ip = ip::inet (the exit_ip bridge lets an
-- order-derived ext_id row reconcile against a snapshot that only agrees on the egress IP).
-- p_complete=false (any fetch error / rate-limit / unrecognized envelope) records an 'incomplete'
-- run and makes ZERO destructive change (P1.8). p_owner_tenant scopes which rows are eligible to be
-- missed (NULL = the global pool). exit_ip is NEVER set from sync (echo-verified import only).
CREATE OR REPLACE FUNCTION linkedin_proxy_sync_apply(
  p_provider     TEXT,
  p_owner_tenant UUID,
  p_snapshot     JSONB,
  p_complete     BOOLEAN,
  p_error        TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run         UUID;
  v_staged      INTEGER := 0;
  v_matched     INTEGER := 0;
  v_unknown     INTEGER := 0;
  v_missed      INTEGER := 0;
  v_gone        INTEGER := 0;
  v_owned       INTEGER := 0;
  v_matched_ids UUID[] := ARRAY[]::UUID[];  -- C7: ids matched (by ext_id OR exit_ip) — miss pass excludes these
  v_gone_after  CONSTANT INTEGER := 3;      -- N consecutive COMPLETE-run misses before provider-gone
  r             RECORD;
  v_hit         INTEGER;
  v_ip_inet     INET;
  v_row_id      UUID;
BEGIN
  IF p_provider IS NULL OR p_provider = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'provider_required');
  END IF;

  -- INCOMPLETE run: audit only, NOTHING destructive (P1.8). A partial/failed fetch must never be
  -- allowed to mark a live proxy gone.
  IF p_complete IS NOT TRUE THEN
    v_staged := COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(p_snapshot) = 'array' THEN p_snapshot ELSE '[]'::jsonb END), 0);
    INSERT INTO linkedin_proxy_sync_runs (provider, owner_tenant_id, status, staged_count, error)
      VALUES (p_provider, p_owner_tenant, 'incomplete', v_staged, p_error)
      RETURNING id INTO v_run;
    RETURN jsonb_build_object('ok', true, 'run_id', v_run, 'status', 'incomplete', 'destructive', false, 'staged', v_staged);
  END IF;

  IF jsonb_typeof(p_snapshot) <> 'array' THEN
    -- A "complete" run must carry an array snapshot; anything else is treated as incomplete
    -- (fail-closed — never let a malformed envelope drive misses).
    INSERT INTO linkedin_proxy_sync_runs (provider, owner_tenant_id, status, error)
      VALUES (p_provider, p_owner_tenant, 'incomplete', 'snapshot_not_array')
      RETURNING id INTO v_run;
    RETURN jsonb_build_object('ok', false, 'run_id', v_run, 'error', 'snapshot_not_array', 'destructive', false);
  END IF;

  v_run := gen_random_uuid();
  v_staged := jsonb_array_length(p_snapshot);

  -- Match pass (C7): a snapshot entry matches a row by ext_id OR by exit_ip = entry.ip::inet, so a
  -- row imported with an order-derived ext_id (e.g. `iproyal:order:...`, the reseller purchase path)
  -- still reconciles against a snapshot that only agrees on the egress IP — an ext_id-only match
  -- would MISS every such row and (after 3 runs) wrongly flag it gone. Refreshes health/expiry/
  -- last_seen + resets the miss counter for every matched row. Scoped to this provider + owner (or
  -- global). reputation_state + assignments are NEVER touched. Entries with no imported row are
  -- counted unknown (provider stock we haven't imported). Entries are DEDUPED by (ext_id, ip) so a
  -- repeated listing can't inflate matched/unknown, and every matched row id is collected into
  -- v_matched_ids (deduped) so a row hit by BOTH keys — or by two entries — counts exactly ONCE, and
  -- the miss pass below can exclude precisely the rows that matched by EITHER key. Each per-entry
  -- UPDATE runs in its OWN subtransaction (BEGIN/EXCEPTION): a bad plan_expires_at cast is caught +
  -- counted unknown/skipped, never aborting the whole reconcile txn and losing the audit row. The ip
  -- is cast to inet inside a guarded nested block so a MALFORMED ip only disables ip-matching for
  -- that entry (ext_id matching still applies) instead of throwing — a garbage ip can't abort the run.
  FOR r IN
    SELECT DISTINCT ON (ext, ip) ext, ip, elem
    FROM (SELECT NULLIF(TRIM(e->>'ext_id'), '') AS ext,
                 NULLIF(TRIM(e->>'ip'), '')     AS ip,
                 e AS elem
            FROM jsonb_array_elements(p_snapshot) e) s
    WHERE ext IS NOT NULL OR ip IS NOT NULL
    ORDER BY ext, ip
  LOOP
    BEGIN
      -- Safe ip → inet: NULL on garbage (keeps ext_id matching alive; no txn abort at the cast).
      BEGIN v_ip_inet := r.ip::inet; EXCEPTION WHEN others THEN v_ip_inet := NULL; END;

      v_hit := 0;
      FOR v_row_id IN
        UPDATE linkedin_proxies SET
          provider_health = CASE
            -- Resurrection: a re-listed proxy that sync itself flagged provider-gone must not stay
            -- blocked — force healthy UNLESS the provider now explicitly reports it unhealthy.
            WHEN provider_gone_at IS NOT NULL
                 AND COALESCE(NULLIF(TRIM(r.elem->>'provider_health'), ''), '') <> 'unhealthy'
              THEN 'healthy'
            WHEN (r.elem->>'provider_health') IN ('healthy','unhealthy') THEN r.elem->>'provider_health'
            ELSE provider_health END,
          plan_expires_at = CASE
            WHEN r.elem ? 'plan_expires_at' AND NULLIF(TRIM(r.elem->>'plan_expires_at'), '') IS NOT NULL
              THEN (r.elem->>'plan_expires_at')::timestamptz
            ELSE plan_expires_at END,
          last_seen_sync = v_run,
          consecutive_sync_misses = 0,
          provider_gone_at = NULL,
          updated_at = now()
        WHERE provider = p_provider
          AND (owner_tenant_id = p_owner_tenant OR (p_owner_tenant IS NULL AND owner_tenant_id IS NULL))
          AND ( (r.ext IS NOT NULL AND ext_id = r.ext)
                OR (v_ip_inet IS NOT NULL AND exit_ip IS NOT NULL AND exit_ip = v_ip_inet) )
        RETURNING id
      LOOP
        v_hit := v_hit + 1;
        IF NOT (v_row_id = ANY (v_matched_ids)) THEN
          v_matched_ids := array_append(v_matched_ids, v_row_id);
        END IF;
      END LOOP;
      IF v_hit = 0 THEN v_unknown := v_unknown + 1; END IF;
    EXCEPTION WHEN others THEN
      -- One bad row can never abort the reconcile txn (cast throw-proofing, P2): skip + count unknown.
      v_unknown := v_unknown + 1;
    END;
  END LOOP;

  -- A row matched by EITHER key (even by multiple entries) counts exactly once.
  v_matched := COALESCE(array_length(v_matched_ids, 1), 0);

  -- Defense in depth (P1): a COMPLETE run that matched NOTHING against a non-empty owned inventory is
  -- almost certainly a silently-changed provider envelope (renamed IP field / new ext_id scheme), not
  -- a real mass-disappearance. Bumping every row toward provider-gone off a bad parse is destructive;
  -- refuse it — record an 'incomplete' run + SKIP the miss pass. A genuinely empty inventory (v_owned
  -- = 0) is unaffected.
  -- C3 (accepted boundary): the flip side is that a REAL full-inventory disappearance (the whole
  -- order lapsing, provider returns []) is never auto-flagged gone here — it lands as a
  -- zero_match_suspicious audit row for an operator to see, not an automatic mass-retire. That is the
  -- deliberate floor: dead proxies fail at transport/send-gate anyway (fail-closed), so we favour
  -- never auto-condemning a live inventory off one odd run over auto-reacting to an empty snapshot.
  SELECT count(*) INTO v_owned FROM linkedin_proxies
    WHERE provider = p_provider
      AND (owner_tenant_id = p_owner_tenant OR (p_owner_tenant IS NULL AND owner_tenant_id IS NULL))
      AND reputation_state <> 'burned';
  IF v_owned > 0 AND v_matched = 0 THEN
    INSERT INTO linkedin_proxy_sync_runs (
      id, provider, owner_tenant_id, status, staged_count, matched_count, unknown_count, error
    ) VALUES (
      v_run, p_provider, p_owner_tenant, 'incomplete', v_staged, v_matched, v_unknown, 'zero_match_suspicious'
    );
    RETURN jsonb_build_object('ok', true, 'run_id', v_run, 'status', 'incomplete', 'destructive', false,
      'error', 'zero_match_suspicious', 'staged', v_staged, 'matched', v_matched,
      'unknown', v_unknown, 'owned', v_owned);
  END IF;

  -- Miss pass: existing rows (this provider+owner scope) absent from the COMPLETE snapshot get their
  -- miss counter bumped. Burned rows are exempt (their denylist row is intentionally permanent).
  -- Crossing N=3 flips provider_health='unhealthy' + stamps provider_gone_at ONCE — reputation_state
  -- and assignments are left alone (an assigned-but-gone proxy fails the send-gate's healthy check,
  -- fail-closed, without an auto-retire from a mere sync miss; P1.15).
  -- C7: "missed" == matched by NEITHER ext_id NOR exit_ip, i.e. its id is not in v_matched_ids (the
  -- ids the match pass collected). Using the SAME match semantics as the match pass closes the gap
  -- where a row matched only by exit_ip would still be bumped by an ext_id-based miss scan.
  UPDATE linkedin_proxies SET
    consecutive_sync_misses = consecutive_sync_misses + 1,
    updated_at = now()
  WHERE provider = p_provider
    AND (owner_tenant_id = p_owner_tenant OR (p_owner_tenant IS NULL AND owner_tenant_id IS NULL))
    AND reputation_state <> 'burned'
    AND NOT (id = ANY (v_matched_ids));
  GET DIAGNOSTICS v_missed = ROW_COUNT;

  UPDATE linkedin_proxies SET
    provider_gone_at = now(),
    provider_health = 'unhealthy',
    updated_at = now()
  WHERE provider = p_provider
    AND (owner_tenant_id = p_owner_tenant OR (p_owner_tenant IS NULL AND owner_tenant_id IS NULL))
    AND reputation_state <> 'burned'
    AND NOT (id = ANY (v_matched_ids))
    AND consecutive_sync_misses >= v_gone_after
    AND provider_gone_at IS NULL;
  GET DIAGNOSTICS v_gone = ROW_COUNT;

  -- Audit row id == v_run (the same id stamped into last_seen_sync above), so a matched proxy's
  -- last_seen_sync points at THIS run's audit row (P3).
  INSERT INTO linkedin_proxy_sync_runs (
    id, provider, owner_tenant_id, status, staged_count, matched_count, unknown_count, missed_count, gone_count
  ) VALUES (
    v_run, p_provider, p_owner_tenant, 'complete', v_staged, v_matched, v_unknown, v_missed, v_gone
  );

  RETURN jsonb_build_object(
    'ok', true, 'run_id', v_run, 'status', 'complete', 'destructive', true,
    'staged', v_staged, 'matched', v_matched, 'unknown', v_unknown,
    'missed', v_missed, 'gone', v_gone
  );
END;
$$;

-- ── Grants: service-role only (no anon/authenticated execute) ─────────────────────
-- C1 added a 5th arg (p_expected_proxy). CREATE OR REPLACE cannot change a signature, so DROP the
-- old 4-arg definition (idempotent) — otherwise both the 4-arg and 5-arg overloads would linger and
-- an unqualified call could bind the wrong one. Re-runnable: the DROP IF EXISTS no-ops once dropped.
DROP FUNCTION IF EXISTS linkedin_apply_proxy_health(UUID,UUID,TEXT,TEXT);
REVOKE ALL ON FUNCTION linkedin_apply_proxy_health(UUID,UUID,TEXT,TEXT,UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION linkedin_proxy_sync_apply(TEXT,UUID,JSONB,BOOLEAN,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION linkedin_apply_proxy_health(UUID,UUID,TEXT,TEXT,UUID) TO service_role;
GRANT EXECUTE ON FUNCTION linkedin_proxy_sync_apply(TEXT,UUID,JSONB,BOOLEAN,TEXT) TO service_role;
