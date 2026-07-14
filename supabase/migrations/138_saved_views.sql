-- Tibexa Core CRM Expansion — saved views + favorites + recents  [138]
-- (v2 Phase 8 / Track E11)
--
-- saved_views ADAPTER (same posture as 120): the shared staging DB already
-- carries a `saved_views` table from the parallel cold-email worktree with
-- columns (id, tenant_id, user_id NOT NULL, name, filters jsonb, columns jsonb,
-- created_at, updated_at). We add two columns of our own and idempotent policies
-- WITHOUT touching their table, data or existing policies. On a FRESH DB the
-- CREATE TABLE IF NOT EXISTS builds it from scratch; on staging every statement
-- is a no-op or an additive ALTER.
--
-- crm_favorites + crm_recents are OURS (114-style RLS): per-user, per-tenant,
-- multi-device personal lists (starred entities + recently-visited entities).

-- ─── saved_views (adapter) ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS saved_views (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  filters     JSONB NOT NULL DEFAULT '{}'::jsonb,
  columns     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Our additive columns (their table lacks them).
ALTER TABLE saved_views ADD COLUMN IF NOT EXISTS entity_type TEXT NOT NULL DEFAULT 'companies';
ALTER TABLE saved_views ADD COLUMN IF NOT EXISTS is_shared BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_saved_views_owner
  ON saved_views (tenant_id, user_id, entity_type);
CREATE INDEX IF NOT EXISTS idx_saved_views_shared
  ON saved_views (tenant_id, entity_type) WHERE is_shared;

-- updated_at trigger only if the table has none and the shared helper exists.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.saved_views'::regclass AND NOT tgisinternal
       AND tgname ILIKE '%updated_at%'
  ) AND EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'update_updated_at'
  ) THEN
    CREATE TRIGGER saved_views_updated_at
      BEFORE UPDATE ON saved_views
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
END $$;

ALTER TABLE saved_views ENABLE ROW LEVEL SECURITY;

-- Idempotent policies (guarded against pg_policies, so re-running or coexisting
-- with the cold-email policies never errors). Access is always via the service
-- role in the API, so these are defense-in-depth for any direct client reads.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='saved_views' AND policyname='saved_views_e11_select') THEN
    CREATE POLICY "saved_views_e11_select" ON saved_views
      FOR SELECT USING (
        (tenant_id = get_user_tenant_id() AND (user_id = auth.uid() OR is_shared))
        OR is_superadmin()
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='saved_views' AND policyname='saved_views_e11_insert') THEN
    CREATE POLICY "saved_views_e11_insert" ON saved_views
      FOR INSERT WITH CHECK (
        (tenant_id = get_user_tenant_id() AND user_id = auth.uid()
          AND get_user_role() IN ('superadmin', 'ops_agent', 'client_admin'))
        OR is_superadmin()
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='saved_views' AND policyname='saved_views_e11_update') THEN
    CREATE POLICY "saved_views_e11_update" ON saved_views
      FOR UPDATE USING (
        (tenant_id = get_user_tenant_id() AND user_id = auth.uid())
        OR is_superadmin()
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='saved_views' AND policyname='saved_views_e11_delete') THEN
    CREATE POLICY "saved_views_e11_delete" ON saved_views
      FOR DELETE USING (
        (tenant_id = get_user_tenant_id() AND user_id = auth.uid())
        OR is_superadmin()
      );
  END IF;
END $$;

COMMENT ON TABLE saved_views IS
  'Named filter+column sets for list pages. Private to the owner unless is_shared, in which case visible to the whole tenant. entity_type scopes which list (companies today).';

-- ─── crm_favorites ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS crm_favorites (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entity_type  TEXT NOT NULL DEFAULT 'companies',
  entity_id    UUID NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT crm_favorites_unique UNIQUE (tenant_id, user_id, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_crm_favorites_user
  ON crm_favorites (tenant_id, user_id, entity_type, created_at DESC);

ALTER TABLE crm_favorites ENABLE ROW LEVEL SECURITY;

CREATE POLICY "crm_favorites_select" ON crm_favorites
  FOR SELECT USING (
    (tenant_id = get_user_tenant_id() AND user_id = auth.uid())
    OR is_superadmin()
  );

CREATE POLICY "crm_favorites_insert" ON crm_favorites
  FOR INSERT WITH CHECK (
    (tenant_id = get_user_tenant_id() AND user_id = auth.uid())
    OR is_superadmin()
  );

CREATE POLICY "crm_favorites_delete" ON crm_favorites
  FOR DELETE USING (
    (tenant_id = get_user_tenant_id() AND user_id = auth.uid())
    OR is_superadmin()
  );

COMMENT ON TABLE crm_favorites IS
  'Per-user starred entities (companies today). Multi-device: lives in the DB, not localStorage. Any authenticated member may favorite — including viewers.';

-- ─── crm_recents ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS crm_recents (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entity_type      TEXT NOT NULL DEFAULT 'companies',
  entity_id        UUID NOT NULL,
  last_visited_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT crm_recents_unique UNIQUE (tenant_id, user_id, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_crm_recents_user
  ON crm_recents (tenant_id, user_id, entity_type, last_visited_at DESC);

ALTER TABLE crm_recents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "crm_recents_select" ON crm_recents
  FOR SELECT USING (
    (tenant_id = get_user_tenant_id() AND user_id = auth.uid())
    OR is_superadmin()
  );

CREATE POLICY "crm_recents_insert" ON crm_recents
  FOR INSERT WITH CHECK (
    (tenant_id = get_user_tenant_id() AND user_id = auth.uid())
    OR is_superadmin()
  );

CREATE POLICY "crm_recents_update" ON crm_recents
  FOR UPDATE USING (
    (tenant_id = get_user_tenant_id() AND user_id = auth.uid())
    OR is_superadmin()
  );

CREATE POLICY "crm_recents_delete" ON crm_recents
  FOR DELETE USING (
    (tenant_id = get_user_tenant_id() AND user_id = auth.uid())
    OR is_superadmin()
  );

COMMENT ON TABLE crm_recents IS
  'Per-user recently-visited entities (companies today), capped to the last 20 per user by the API. Multi-device via the DB.';

-- ─── crm_recents_record (atomic upsert + trim) ───────────────────────────────
-- The API's original record-a-visit path did upsert + "delete everything past row
-- N" in two separate statements. Two concurrent visits by the same user could both
-- read the list before either deleted, leaving 21+ rows (a budama yarışı / trim
-- race). This RPC folds upsert + trim into ONE transaction guarded by a per-
-- (tenant,user,entity_type) advisory lock, so concurrent visits serialize and the
-- cap always holds. The API falls back to its two-step path if this function is
-- absent (migration not yet applied), so deploy order never breaks recents.
CREATE OR REPLACE FUNCTION crm_recents_record(
  p_tenant_id   UUID,
  p_user_id     UUID,
  p_entity_type TEXT,
  p_entity_id   UUID,
  p_cap         INT DEFAULT 20
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Serialize concurrent visits by the same key for the duration of this txn.
  PERFORM pg_advisory_xact_lock(
    hashtext(p_tenant_id::text || ':' || p_user_id::text || ':' || p_entity_type)
  );

  INSERT INTO crm_recents (tenant_id, user_id, entity_type, entity_id, last_visited_at)
  VALUES (p_tenant_id, p_user_id, p_entity_type, p_entity_id, now())
  ON CONFLICT (tenant_id, user_id, entity_type, entity_id)
  DO UPDATE SET last_visited_at = now();

  DELETE FROM crm_recents
   WHERE id IN (
     SELECT id FROM crm_recents
      WHERE tenant_id = p_tenant_id
        AND user_id = p_user_id
        AND entity_type = p_entity_type
      ORDER BY last_visited_at DESC
      OFFSET GREATEST(p_cap, 0)
   );
END;
$$;

-- service_role-only: the API always calls this via the service key. Revoke the
-- default PUBLIC execute grant (SECURITY DEFINER makes that posture mandatory).
REVOKE ALL ON FUNCTION crm_recents_record(UUID, UUID, TEXT, UUID, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_recents_record(UUID, UUID, TEXT, UUID, INT) TO service_role;
