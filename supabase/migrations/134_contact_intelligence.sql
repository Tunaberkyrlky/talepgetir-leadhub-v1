-- Contact intelligence — sales-context fields on the shared `contacts` table  [134]
-- (v2 Phase 6). `contacts` is a LIVE, SHARED staging table, so this migration is
-- strictly ADDITIVE and idempotent: new nullable columns (IF NOT EXISTS), CHECK
-- constraints re-created via DROP IF EXISTS + ADD (verbatim 120 discipline), and
-- partial indexes (IF NOT EXISTS). No existing column, policy, RLS or trigger is
-- touched. On any DB (fresh or staging) every statement is a no-op or idempotent
-- re-create. The new columns start NULL, so the CHECKs (which admit NULL) can never
-- fail against pre-existing rows.

-- Sales-context columns (their table lacks them)
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS buying_role         TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS relationship_status TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS preferred_channel   TEXT;

-- Closed vocabularies. NULL always allowed (most existing rows carry no signal yet).
ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_buying_role_check;
ALTER TABLE contacts ADD CONSTRAINT contacts_buying_role_check
  CHECK (buying_role IS NULL OR buying_role IN
    ('decision_maker', 'influencer', 'champion', 'user', 'blocker'));

ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_relationship_status_check;
ALTER TABLE contacts ADD CONSTRAINT contacts_relationship_status_check
  CHECK (relationship_status IS NULL OR relationship_status IN
    ('active', 'passive', 'left_company'));

ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_preferred_channel_check;
ALTER TABLE contacts ADD CONSTRAINT contacts_preferred_channel_check
  CHECK (preferred_channel IS NULL OR preferred_channel IN
    ('email', 'phone', 'whatsapp', 'linkedin', 'other'));

-- Partial indexes for the People filters (only the rows that carry a signal).
CREATE INDEX IF NOT EXISTS idx_contacts_tenant_buying_role
  ON contacts (tenant_id, buying_role) WHERE buying_role IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_tenant_relationship_status
  ON contacts (tenant_id, relationship_status) WHERE relationship_status IS NOT NULL;
