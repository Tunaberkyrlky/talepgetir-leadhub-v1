-- Tibexa Core CRM Expansion R1 — tasks hardening  [115]
-- Two fences on top of 114's tasks table:
--   (a) a BEFORE INSERT/UPDATE trigger that keeps company_id / contact_id inside the
--       row's own tenant (a mis-scoped write is a cross-tenant leak, not a 404), and
--   (b) locking complete_crm_task down to service_role, matching the DML-revoke posture
--       the rest of the app uses (only the API's service-role client may complete a task).

-- (a) Tenant-consistency guard --------------------------------------------------------
-- company_id MUST resolve to a company in the same tenant; contact_id (when present)
-- MUST resolve to a contact of that same company (which pins the tenant too).
-- assigned_to is DELIBERATELY not checked here: internal roles (superadmin / ops_agent)
-- may legitimately be assigned across tenants, so a tenant/membership constraint on
-- assigned_to would be wrong.
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

-- (b) Lock complete_crm_task to service_role -----------------------------------------
-- Signature taken verbatim from 114: (p_tenant_id, p_task_id, p_completed_by,
-- p_create_activity BOOLEAN, p_result_summary TEXT, p_result_detail TEXT).
REVOKE EXECUTE ON FUNCTION complete_crm_task(UUID, UUID, UUID, BOOLEAN, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION complete_crm_task(UUID, UUID, UUID, BOOLEAN, TEXT, TEXT)
  TO service_role;
