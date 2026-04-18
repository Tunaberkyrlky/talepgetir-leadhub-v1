-- ============================================================================
-- 032: Campaigns + Steps + Enrollments + Email Events
-- Drip kampanya şablonları, per-lead state machine, tracking
-- campaign_steps FUP-ready: condition kolonları nullable olarak hazır
-- ============================================================================

-- ── Kampanya şablonları ────────────────────────────────────────────────────

CREATE TABLE campaigns (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    description     TEXT,
    status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'active', 'paused', 'completed')),
    from_name       TEXT,
    settings        JSONB DEFAULT '{}',
    total_enrolled  INTEGER NOT NULL DEFAULT 0,
    created_by      UUID REFERENCES auth.users(id),
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TRIGGER campaigns_updated_at
    BEFORE UPDATE ON campaigns
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX idx_campaigns_tenant ON campaigns(tenant_id, status);

-- ── Kampanya adımları ──────────────────────────────────────────────────────
-- step_type: email, delay (Drip MVP), condition (FUP — sonraki faz)
-- FUP kolonları (condition_type, condition_wait_hours, parent_step_id,
-- branch_label) şimdiden var ama nullable — migration gerekmeden FUP eklenir.

CREATE TABLE campaign_steps (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id         UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    step_order          INTEGER NOT NULL,
    step_type           TEXT NOT NULL CHECK (step_type IN ('email', 'delay', 'condition')),
    -- email step:
    subject             TEXT,
    body_html           TEXT,
    body_text           TEXT,
    -- delay step:
    delay_days          INTEGER NOT NULL DEFAULT 0,
    delay_hours         INTEGER NOT NULL DEFAULT 0,
    -- condition step (FUP — MVP'de kullanılmaz):
    condition_type      TEXT CHECK (condition_type IN (
                            'opened', 'clicked', 'replied',
                            'not_opened', 'not_clicked', 'not_replied'
                        )),
    condition_wait_hours INTEGER DEFAULT 72,
    parent_step_id      UUID REFERENCES campaign_steps(id) ON DELETE SET NULL,
    branch_label        TEXT,
    --
    created_at          TIMESTAMPTZ DEFAULT now(),
    updated_at          TIMESTAMPTZ DEFAULT now(),
    UNIQUE(campaign_id, step_order)
);

CREATE INDEX idx_campaign_steps_campaign ON campaign_steps(campaign_id, step_order);

-- ── Per-lead enrollment state machine ──────────────────────────────────────

CREATE TABLE campaign_enrollments (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_id         UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    contact_id          UUID REFERENCES contacts(id) ON DELETE SET NULL,
    company_id          UUID REFERENCES companies(id) ON DELETE SET NULL,
    email               TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN (
                            'active', 'completed', 'paused',
                            'replied', 'bounced', 'unsubscribed'
                        )),
    current_step_id     UUID REFERENCES campaign_steps(id),
    next_scheduled_at   TIMESTAMPTZ,
    branch_path         TEXT NOT NULL DEFAULT '/',
    enrolled_at         TIMESTAMPTZ DEFAULT now(),
    completed_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ DEFAULT now(),
    updated_at          TIMESTAMPTZ DEFAULT now(),
    UNIQUE(campaign_id, email)
);

CREATE TRIGGER campaign_enrollments_updated_at
    BEFORE UPDATE ON campaign_enrollments
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Scheduler index — sadece due active enrollment'ları kapsar
CREATE INDEX idx_enrollments_due
    ON campaign_enrollments(next_scheduled_at)
    WHERE status = 'active' AND next_scheduled_at IS NOT NULL;

CREATE INDEX idx_enrollments_campaign
    ON campaign_enrollments(campaign_id);

-- ── Per-email tracking olayları ────────────────────────────────────────────
-- activity_id → gönderilmiş email'in activities kaydına referans

CREATE TABLE campaign_email_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    activity_id     UUID NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
    enrollment_id   UUID REFERENCES campaign_enrollments(id) ON DELETE SET NULL,
    event_type      TEXT NOT NULL CHECK (event_type IN ('open', 'click', 'bounce', 'reply')),
    event_data      JSONB,
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_campaign_events_activity
    ON campaign_email_events(activity_id, event_type);

CREATE INDEX idx_campaign_events_enrollment
    ON campaign_email_events(enrollment_id)
    WHERE enrollment_id IS NOT NULL;

-- ── RLS ────────────────────────────────────────────────────────────────────

ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_email_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Tenant isolation" ON campaigns
    FOR ALL USING (tenant_id = get_user_tenant_id());

CREATE POLICY "Tenant isolation" ON campaign_enrollments
    FOR ALL USING (tenant_id = get_user_tenant_id());

CREATE POLICY "Tenant via campaign" ON campaign_steps
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM campaigns c
            WHERE c.id = campaign_steps.campaign_id
            AND c.tenant_id = get_user_tenant_id()
        )
    );

CREATE POLICY "Tenant via activity" ON campaign_email_events
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM activities a
            WHERE a.id = campaign_email_events.activity_id
            AND a.tenant_id = get_user_tenant_id()
        )
    );
