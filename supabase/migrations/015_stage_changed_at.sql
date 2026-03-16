-- Track when a company's stage was last changed (for pipeline "days in stage" display)
ALTER TABLE companies ADD COLUMN stage_changed_at TIMESTAMPTZ;

-- Trigger: auto-update stage_changed_at when stage changes
CREATE OR REPLACE FUNCTION update_stage_changed_at()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.stage IS DISTINCT FROM NEW.stage THEN
        NEW.stage_changed_at = NOW();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_stage_changed_at
    BEFORE UPDATE ON companies
    FOR EACH ROW
    EXECUTE FUNCTION update_stage_changed_at();

-- Backfill existing rows with updated_at
UPDATE companies SET stage_changed_at = updated_at WHERE stage_changed_at IS NULL;
