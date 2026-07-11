-- Tibexa Core CRM Expansion — shared-tasks adapter  [120]
-- The shared staging DB already carries a `tasks` table from the parallel
-- cold-email worktree (its 061_tasks: status vocabulary 'open', a `description`
-- column, same RLS policy names). Our CRM task stack (114/115) expects
-- status 'pending', `detail` + `completed_by` columns, the complete_crm_task RPC
-- and the tenant-consistency trigger. Applying 114 as-is would collide, so this
-- ADAPTER makes the existing table serve both streams (user-approved 2026-07-11):
--   * their code/data stay untouched ('open' rows remain valid, `description`
--     kept, RLS policies and their indexes untouched);
--   * our columns/RPC/trigger/indexes are added guardedly.
-- On a FRESH DB built from this repo (114 already ran) every statement here is a
-- no-op or an idempotent re-create. NOT added on purpose: 114's
-- tasks_completion_state CHECK (their historical rows may violate it — server
-- logic enforces the invariant instead) and RLS policies (same-named ones exist).

-- Our columns (their table lacks them)
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS detail TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- Widen the status vocabulary: keep their 'open', admit our 'pending'.
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('open', 'pending', 'completed', 'cancelled'));

-- Our pending-focused partial indexes (their idx_tasks_* remain)
CREATE INDEX IF NOT EXISTS idx_tasks_tenant_due
  ON tasks (tenant_id, due_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_tasks_company_due
  ON tasks (tenant_id, company_id, due_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_tasks_assignee_due
  ON tasks (tenant_id, assigned_to, due_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_tasks_contact
  ON tasks (tenant_id, contact_id) WHERE contact_id IS NOT NULL;

-- updated_at trigger only if the table has none and the shared helper exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.tasks'::regclass AND NOT tgisinternal
       AND tgname ILIKE '%updated_at%'
  ) AND EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'update_updated_at'
  ) THEN
    CREATE TRIGGER tasks_updated_at
      BEFORE UPDATE ON tasks
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
END $$;

-- Tenant-consistency fence (verbatim 115 semantics; idempotent re-create).
-- company_id must resolve to a company in the row's tenant; contact_id (when
-- present) must belong to that same company. assigned_to deliberately unchecked
-- (internal roles legitimately own cross-tenant).
CREATE OR REPLACE FUNCTION tasks_assert_tenant_consistency()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.companies
     WHERE id = NEW.company_id AND tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'tasks: company % does not belong to tenant %', NEW.company_id, NEW.tenant_id;
  END IF;

  IF NEW.contact_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.contacts
     WHERE id = NEW.contact_id AND tenant_id = NEW.tenant_id AND company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'tasks: contact % does not belong to company % in tenant %',
      NEW.contact_id, NEW.company_id, NEW.tenant_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tasks_tenant_consistency ON public.tasks;
CREATE TRIGGER tasks_tenant_consistency
  BEFORE INSERT OR UPDATE OF tenant_id, company_id, contact_id ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION tasks_assert_tenant_consistency();

-- Atomic completion RPC (verbatim 114 body) + 115 grant posture.
CREATE OR REPLACE FUNCTION complete_crm_task(
  p_tenant_id UUID,
  p_task_id UUID,
  p_completed_by UUID,
  p_create_activity BOOLEAN DEFAULT false,
  p_result_summary TEXT DEFAULT NULL,
  p_result_detail TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_task tasks%ROWTYPE;
  v_activity_id UUID;
BEGIN
  UPDATE tasks
     SET status = 'completed',
         completed_at = now(),
         completed_by = p_completed_by
   WHERE id = p_task_id
     AND tenant_id = p_tenant_id
     AND status = 'pending'
  RETURNING * INTO v_task;

  IF v_task.id IS NULL THEN
    RAISE EXCEPTION 'Pending task not found';
  END IF;

  IF p_create_activity THEN
    IF p_result_summary IS NULL OR btrim(p_result_summary) = '' THEN
      RAISE EXCEPTION 'Result summary is required';
    END IF;

    INSERT INTO activities (
      tenant_id, company_id, contact_id, type, summary, detail,
      visibility, occurred_at, created_by
    ) VALUES (
      p_tenant_id, v_task.company_id, v_task.contact_id, 'not',
      btrim(p_result_summary), p_result_detail, 'client', now(), p_completed_by
    )
    RETURNING id INTO v_activity_id;
  END IF;

  RETURN jsonb_build_object(
    'task', to_jsonb(v_task),
    'activity_id', v_activity_id
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION complete_crm_task(UUID, UUID, UUID, BOOLEAN, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION complete_crm_task(UUID, UUID, UUID, BOOLEAN, TEXT, TEXT)
  TO service_role;
