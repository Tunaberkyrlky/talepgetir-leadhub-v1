-- ============================================================================
-- 021: Custom Pipeline Stages (per-tenant)
-- ============================================================================
-- Moves pipeline stages from hardcoded constants to a per-tenant table,
-- allowing tenants to add, rename, reorder, and remove stages.
-- ============================================================================

-- 1. Create pipeline_stages table
CREATE TABLE IF NOT EXISTS pipeline_stages (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    slug        TEXT NOT NULL,
    display_name TEXT NOT NULL,
    color       TEXT NOT NULL DEFAULT 'gray',
    sort_order  INT NOT NULL DEFAULT 0,
    stage_type  TEXT NOT NULL DEFAULT 'pipeline'
                CHECK (stage_type IN ('initial', 'pipeline', 'terminal')),
    is_active   BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(tenant_id, slug)
);

-- 2. RLS
ALTER TABLE pipeline_stages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pipeline_stages_tenant_select"
    ON pipeline_stages FOR SELECT
    USING (tenant_id = ((current_setting('request.jwt.claims', true)::json)->'app_metadata'->>'tenant_id')::UUID);

CREATE POLICY "pipeline_stages_tenant_insert"
    ON pipeline_stages FOR INSERT
    WITH CHECK (tenant_id = ((current_setting('request.jwt.claims', true)::json)->'app_metadata'->>'tenant_id')::UUID);

CREATE POLICY "pipeline_stages_tenant_update"
    ON pipeline_stages FOR UPDATE
    USING (tenant_id = ((current_setting('request.jwt.claims', true)::json)->'app_metadata'->>'tenant_id')::UUID);

CREATE POLICY "pipeline_stages_tenant_delete"
    ON pipeline_stages FOR DELETE
    USING (tenant_id = ((current_setting('request.jwt.claims', true)::json)->'app_metadata'->>'tenant_id')::UUID);

-- 3. Index for fast lookups
CREATE INDEX idx_pipeline_stages_tenant ON pipeline_stages(tenant_id, sort_order);

-- 4. Seed default stages for all existing tenants
INSERT INTO pipeline_stages (tenant_id, slug, display_name, color, sort_order, stage_type)
SELECT t.id, s.slug, s.display_name, s.color, s.sort_order, s.stage_type
FROM tenants t
CROSS JOIN (VALUES
    ('cold',           'Cold',           'gray',   0,  'initial'),
    ('in_queue',       'In Queue',       'blue',   1,  'pipeline'),
    ('first_contact',  'First Contact',  'cyan',   2,  'pipeline'),
    ('connected',      'Connected',      'indigo', 3,  'pipeline'),
    ('qualified',      'Qualified',      'teal',   4,  'pipeline'),
    ('in_meeting',     'In Meeting',     'yellow', 5,  'pipeline'),
    ('follow_up',      'Follow Up',      'orange', 6,  'pipeline'),
    ('proposal_sent',  'Proposal Sent',  'violet', 7,  'pipeline'),
    ('negotiation',    'Negotiation',    'grape',  8,  'pipeline'),
    ('won',            'Won',            'green',  9,  'terminal'),
    ('lost',           'Lost',           'red',    10, 'terminal'),
    ('on_hold',        'On Hold',        'gray',   11, 'terminal')
) AS s(slug, display_name, color, sort_order, stage_type)
ON CONFLICT (tenant_id, slug) DO NOTHING;

-- 5. Drop the CHECK constraint on companies.stage
-- (The constraint name may vary; try both possible names)
DO $$
BEGIN
    ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_stage_check;
    ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_stage_check1;
EXCEPTION WHEN undefined_object THEN
    NULL;
END $$;
