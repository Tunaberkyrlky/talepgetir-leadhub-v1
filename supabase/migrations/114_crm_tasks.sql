-- Tibexa Core CRM Expansion R1
-- Separate future work (tasks) from historical interactions (activities).

CREATE TABLE tasks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  contact_id    UUID REFERENCES contacts(id) ON DELETE SET NULL,
  title         TEXT NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 1000),
  detail        TEXT,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'completed', 'cancelled')),
  priority      TEXT NOT NULL DEFAULT 'normal'
                CHECK (priority IN ('low', 'normal', 'high')),
  due_at        TIMESTAMPTZ NOT NULL,
  assigned_to   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  completed_at  TIMESTAMPTZ,
  completed_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tasks_completion_state CHECK (
    (status = 'completed' AND completed_at IS NOT NULL)
    OR (status <> 'completed' AND completed_at IS NULL AND completed_by IS NULL)
  )
);

CREATE INDEX idx_tasks_tenant_due
  ON tasks (tenant_id, due_at)
  WHERE status = 'pending';

CREATE INDEX idx_tasks_company_due
  ON tasks (tenant_id, company_id, due_at)
  WHERE status = 'pending';

CREATE INDEX idx_tasks_assignee_due
  ON tasks (tenant_id, assigned_to, due_at)
  WHERE status = 'pending';

CREATE INDEX idx_tasks_contact
  ON tasks (tenant_id, contact_id)
  WHERE contact_id IS NOT NULL;

CREATE TRIGGER tasks_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tasks_select" ON tasks
  FOR SELECT USING (
    tenant_id = get_user_tenant_id()
    OR is_superadmin()
  );

CREATE POLICY "tasks_insert" ON tasks
  FOR INSERT WITH CHECK (
    (tenant_id = get_user_tenant_id()
      AND get_user_role() IN ('superadmin', 'ops_agent', 'client_admin'))
    OR is_superadmin()
  );

CREATE POLICY "tasks_update" ON tasks
  FOR UPDATE USING (
    (tenant_id = get_user_tenant_id()
      AND get_user_role() IN ('superadmin', 'ops_agent', 'client_admin'))
    OR is_superadmin()
  );

CREATE POLICY "tasks_delete" ON tasks
  FOR DELETE USING (
    (tenant_id = get_user_tenant_id()
      AND get_user_role() IN ('superadmin', 'ops_agent', 'client_admin'))
    OR is_superadmin()
  );

COMMENT ON TABLE tasks IS
  'Future CRM work. Historical events remain in activities; pending tasks drive next-action and agenda views.';

COMMENT ON COLUMN tasks.due_at IS
  'A task is overdue only when status=pending and due_at is earlier than now().';

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
      tenant_id,
      company_id,
      contact_id,
      type,
      summary,
      detail,
      visibility,
      occurred_at,
      created_by
    ) VALUES (
      p_tenant_id,
      v_task.company_id,
      v_task.contact_id,
      'not',
      btrim(p_result_summary),
      p_result_detail,
      'client',
      now(),
      p_completed_by
    )
    RETURNING id INTO v_activity_id;
  END IF;

  RETURN jsonb_build_object(
    'task', to_jsonb(v_task),
    'activity_id', v_activity_id
  );
END;
$$;
