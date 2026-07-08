-- ==========================================
-- TG-Research v2 — WP1 calibration hardening round 2 (codex FIX-FIRST #4)  [087]
--
-- Calibration evidence is PER-RULESET. When the ruleset arrays change (manual edit or
-- apply-revision), the 062/085 trigger already bumps the version, demotes approved→draft
-- and clears any pending revision proposal — but it left calibration_state/'calibrated_at'
-- standing, so a calibrated ICP edited and re-approved still CLAIMED calibration for a
-- ruleset that was never sampled. Reset both: a new ruleset starts uncalibrated.
-- ==========================================

CREATE OR REPLACE FUNCTION research_icps_ruleset_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (NEW.signals           IS DISTINCT FROM OLD.signals)
  OR (NEW.negative_signals  IS DISTINCT FROM OLD.negative_signals)
  OR (NEW.neutral_signals   IS DISTINCT FROM OLD.neutral_signals)
  OR (NEW.elimination_rules IS DISTINCT FROM OLD.elimination_rules) THEN
    NEW.ruleset_version := OLD.ruleset_version + 1;
    -- An edited ruleset can never remain approved on the strength of the OLD rules.
    IF OLD.status = 'approved' AND NEW.status = 'approved' THEN
      NEW.status := 'draft';
    END IF;
    -- A pending revision proposal was computed against the OLD rules — clear it (085).
    NEW.revision_draft := NULL;
    NEW.revision_job_id := NULL;
    -- Calibration evidence is per-ruleset — a new ruleset starts uncalibrated (087).
    NEW.calibration_state := 'none';
    NEW.calibrated_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;
