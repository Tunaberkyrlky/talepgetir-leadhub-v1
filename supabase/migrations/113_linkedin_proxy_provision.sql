-- ==========================================
-- 113_linkedin_proxy_provision.sql
-- TG-LinkedIn Proxy P3 — IPRoyal reseller auto-provision (quote → order → poll → import).
-- Design: Tg-LinkedIn/04_STATIC_PROXY_POOL.md §7 row P3 + §11 (LIVE proof of the reseller flow).
--
-- P0/P1/P2 (migs 106-111) all assumed an operator already BOUGHT an IP by hand on the IPRoyal
-- dashboard and pasted the verified host:port:user:pass to the server. P3 lets an internal
-- operator drive the purchase from inside the app via the reseller API, but with a hard,
-- multi-layer spend guard so a real charge can NEVER happen by accident:
--
--   1. QUOTE (read-only catalog lookup) inserts a row here with status='quoted' and the priced
--      product/plan. NO money moves. The row is the spend-authorization token.
--   2. CONFIRM must re-present that fresh quote id (< 15 min old, same tenant, still 'quoted'),
--      pass a per-tenant daily cap (< 3 orders that may have spent / 24h), and the reseller env
--      must be present. The cap-check AND the quoted→ordered claim happen in ONE atomic RPC
--      (linkedin_claim_provision_order) under a per-tenant advisory lock, so the money call
--      (placeOrder) is reached only after a single transaction both proved under-cap AND claimed
--      this exact quote. Only then does the route call the order-create endpoint.
--   3. Poll flips 'ordered' → 'confirmed'/'importing' → 'imported'/'import_failed' once credentials
--      arrive and pass the SAME server-side SSRF + echo-verify + burned-denylist import path as the
--      manual P0/P1 routes.
--
-- SPEND-SAFETY STATUS MODEL — which states burn a daily-cap slot:
--   'quoted'        pre-spend authorization token .............. NOT counted (ordered_at IS NULL)
--   'failed'        pre-spend abort (never reached placeOrder) .. NOT counted (ordered_at IS NULL)
--   'ordered'       claim succeeded, placeOrder called/pending .. COUNTED  (may have charged)
--   'confirmed'     poll returned credentials .................. COUNTED
--   'importing'     import in flight (CAS-claimed) ............. COUNTED
--   'imported'      import succeeded ........................... COUNTED
--   'import_failed' PAID order whose import failed ............. COUNTED  (must NEVER un-count)
-- The cap counts by ordered_at (the purchase timestamp, stamped ONLY by the atomic claim and never
-- cleared), NOT created_at (the quote timestamp) — so a slow poll/import can never let an order
-- "age out" of the cap by quote time, and a post-payment import failure keeps burning its slot.
--
-- This table is the audit trail + the per-day spend-guard data. Deny-all RLS (service-role only);
-- the provision route uses the research service-role client, which bypasses RLS like the other
-- linkedin_proxy tables. Additive + re-runnable.
-- ==========================================

CREATE TABLE IF NOT EXISTS linkedin_proxy_orders (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  provider      TEXT NOT NULL DEFAULT 'iproyal',
  -- The account this quote was priced for (its geo drove the country). NULL = pool-only order
  -- (import into the pool without binding an account). Stored on the quote so CONFIRM can't be
  -- pointed at a different account than the one the price/geo was derived from.
  account_id    UUID,
  ext_order_id  TEXT,                              -- provider order id (NULL until 'ordered')
  country       TEXT,                              -- ISO-2 lower (the account's / requested geo)
  product_id    INTEGER,                           -- IPRoyal product id (ISP Dedicated = 9)
  plan_id       INTEGER,                           -- IPRoyal product_plan_id (30 Days = 22)
  quoted_price  NUMERIC,                           -- price at quote time (per-unit, USD)
  status        TEXT NOT NULL DEFAULT 'quoted'
                  CHECK (status IN ('quoted','ordered','confirmed','importing','imported','failed','import_failed')),
  error         TEXT,
  proxy_id      UUID,                              -- linkedin_proxies.id once imported
  -- Purchase timestamp: stamped ONLY by linkedin_claim_provision_order at the quoted→ordered
  -- transition (i.e. the instant before placeOrder can charge), and NEVER cleared afterward. This
  -- is the authoritative daily-cap clock — any row with ordered_at set may have spent money and
  -- must keep counting toward the cap regardless of its terminal status.
  ordered_at    TIMESTAMPTZ,
  created_by    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Re-runnable upgrade for a DB where an earlier form of this table already exists ──
-- (Additive: adds ordered_at and widens the status CHECK to the full spend-safety model.)
ALTER TABLE linkedin_proxy_orders ADD COLUMN IF NOT EXISTS ordered_at TIMESTAMPTZ;

-- Backfill ordered_at for any pre-existing rows from an earlier form of this table, so a re-run
-- against a DB that already has data can't let possibly-charged rows silently escape the daily
-- cap (the cap counts by ordered_at, not created_at — see the status model above). Idempotent:
-- only touches rows where ordered_at is still NULL, using the best available proxy timestamp.
UPDATE linkedin_proxy_orders
   SET ordered_at = COALESCE(ordered_at, updated_at, created_at)
 WHERE ordered_at IS NULL
   AND status IN ('ordered','confirmed','importing','imported','import_failed');

-- NOTE on legacy 'failed' rows — NOT remapped to counted here, and this is a documented no-op:
-- this table (linkedin_proxy_orders) and the /proxies/provision route are BRAND NEW in this same
-- commit batch (mig 113 is the table's first-ever version; no earlier migration created it, and
-- `git diff HEAD -- server/src/routes/linkedin/proxies.ts` shows the entire P3 confirm/finishOrder
-- code as pure insertions with zero deletions — i.e. this code has never previously been committed
-- or deployed). There is therefore no historical code path that could have set status='failed'
-- AFTER a successful placeOrder charge: 'failed' has only ever meant a pre-spend abort (quote
-- invalid / cap hit / catalog shifted), and finishOrder has always landed a post-charge import
-- failure on the COUNTED 'import_failed' state, never on 'failed'. If this migration is ever
-- copy-pasted as a template for a table that DOES have real legacy 'failed' rows written by an
-- older version of the route that used 'failed' post-charge, a targeted remap keyed on whatever
-- column distinguishes pre- vs post-charge (e.g. ext_order_id IS NOT NULL) would be required
-- there instead of this no-op.
ALTER TABLE linkedin_proxy_orders DROP CONSTRAINT IF EXISTS linkedin_proxy_orders_status_check;
ALTER TABLE linkedin_proxy_orders ADD CONSTRAINT linkedin_proxy_orders_status_check
  CHECK (status IN ('quoted','ordered','confirmed','importing','imported','failed','import_failed'));

-- Per-tenant daily spend-guard count keyed on the PURCHASE clock (ordered_at). Also serves the
-- GET re-poll lookup (tenant + id).
CREATE INDEX IF NOT EXISTS linkedin_proxy_orders_tenant_status_created
  ON linkedin_proxy_orders (tenant_id, status, created_at);
CREATE INDEX IF NOT EXISTS linkedin_proxy_orders_tenant_ordered_at
  ON linkedin_proxy_orders (tenant_id, ordered_at);

ALTER TABLE linkedin_proxy_orders ENABLE ROW LEVEL SECURITY;
-- Deny-all: no anon/authenticated policy exists, so only the service-role client (which bypasses
-- RLS) can read/write. Matches migs 106/108 for the other linkedin_proxy tables.

-- ── RPC: count recent may-have-spent orders for the daily cap ──
-- "Recent may-have-spent" = a row with a purchase timestamp (ordered_at) inside p_hours. Because
-- ordered_at is stamped only at claim time and never cleared, this counts EVERY order that reached
-- (or passed) the money call within the window — including 'ordered'/'import_failed' — and excludes
-- pre-spend rows ('quoted','failed', ordered_at NULL). Kept for smoke/observability; the authoritative
-- cap check lives inside linkedin_claim_provision_order (below), atomic with the claim.
CREATE OR REPLACE FUNCTION linkedin_count_recent_orders(p_tenant UUID, p_hours INTEGER)
RETURNS INTEGER
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(*)::INTEGER FROM linkedin_proxy_orders
   WHERE tenant_id = p_tenant
     AND status IN ('ordered','confirmed','importing','imported','import_failed')
     AND ordered_at IS NOT NULL
     AND ordered_at > now() - make_interval(hours => p_hours);
$$;

REVOKE ALL ON FUNCTION linkedin_count_recent_orders(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION linkedin_count_recent_orders(UUID, INTEGER) TO service_role;

-- ── RPC: atomic daily-cap check + quoted→ordered claim (the single spend gate) ──
-- This is the ONLY place a quote can transition quoted→ordered. In ONE transaction, under a
-- per-tenant advisory lock, it (a) re-validates the quote (exists, same tenant, still 'quoted',
-- < 15 min old) as a PRE-SPEND condition, (b) counts may-have-spent orders in the last 24h by
-- ordered_at and refuses at the cap (PRE-SPEND — no charge, no claim), and only then (c) stamps
-- the row 'ordered' + ordered_at=now(). The route calls placeOrder ONLY when this returns ok:true,
-- so a real charge can never happen unless a single atomic tx both proved under-cap AND claimed
-- this exact quote. A DB error here throws → the route fails closed (never reaches placeOrder).
CREATE OR REPLACE FUNCTION linkedin_claim_provision_order(p_tenant UUID, p_quote_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row  linkedin_proxy_orders;
  v_cnt  INTEGER;
BEGIN
  -- Serialize the entire claim per tenant, so two concurrent confirms for DIFFERENT fresh quotes
  -- at cap-1 can't both read "under cap" and both claim: whichever grabs the lock first runs its
  -- whole count+claim before the second reads. Same idiom as migs 108/109.
  PERFORM pg_advisory_xact_lock(hashtextextended('linkedin_provision:' || p_tenant::text, 99));

  -- (a) Lock + re-read the quote row. PRE-SPEND validity: must exist, same tenant, still 'quoted',
  --     younger than 15 minutes. Any failure → quote_invalid (no charge, row untouched).
  SELECT * INTO v_row FROM linkedin_proxy_orders
    WHERE id = p_quote_id AND tenant_id = p_tenant
    FOR UPDATE;
  IF NOT FOUND
     OR v_row.status <> 'quoted'
     OR v_row.created_at <= now() - interval '15 minutes' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'quote_invalid');
  END IF;

  -- (b) Daily cap on may-have-spent orders in the last 24h, by ordered_at (purchase clock). The
  --     counted status set is EVERY state reachable after a possible charge; pre-spend rows
  --     ('quoted','failed') have ordered_at IS NULL and are excluded automatically.
  SELECT COUNT(*)::INTEGER INTO v_cnt FROM linkedin_proxy_orders
    WHERE tenant_id = p_tenant
      AND status IN ('ordered','confirmed','importing','imported','import_failed')
      AND ordered_at IS NOT NULL
      AND ordered_at > now() - interval '24 hours';
  IF v_cnt >= 3 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'daily_cap');
  END IF;

  -- (c) Claim: quoted → ordered, stamp the immutable purchase clock. Single-use — a second claim
  --     of the same quote now fails the status<>'quoted' check above.
  UPDATE linkedin_proxy_orders
     SET status = 'ordered', ordered_at = now(), updated_at = now()
   WHERE id = p_quote_id;

  RETURN jsonb_build_object(
    'ok', true,
    'order_id', p_quote_id,
    'country', v_row.country,
    'product_id', v_row.product_id,
    'plan_id', v_row.plan_id,
    'quoted_price', v_row.quoted_price,
    'account_id', v_row.account_id
  );
END;
$$;

REVOKE ALL ON FUNCTION linkedin_claim_provision_order(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION linkedin_claim_provision_order(UUID, UUID) TO service_role;
