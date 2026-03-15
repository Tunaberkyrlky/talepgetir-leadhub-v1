-- ==========================================
-- 013: Update company stages (ordered enum)
-- ==========================================
-- New pipeline stages:
--   0: in_queue, 1: first_contact, 2: connected, 3: qualified,
--   4: in_meeting, 5: follow_up, 6: proposal_sent, 7: negotiation,
--   8: won, 9: lost, 10: on_hold

-- Step 1: Drop old CHECK constraint first (so new values can be written)
ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_stage_check;

-- Step 2: Migrate existing stage values to new equivalents
UPDATE companies SET stage = 'in_queue'      WHERE stage = 'new';
UPDATE companies SET stage = 'first_contact' WHERE stage = 'researching';
UPDATE companies SET stage = 'connected'     WHERE stage = 'contacted';
UPDATE companies SET stage = 'in_meeting'    WHERE stage = 'meeting_scheduled';
-- proposal_sent, negotiation, won, lost, on_hold remain the same

-- Step 3: Set new default and add new CHECK constraint
ALTER TABLE companies
  ALTER COLUMN stage SET DEFAULT 'in_queue',
  ADD CONSTRAINT companies_stage_check
    CHECK (stage IN (
      'in_queue', 'first_contact', 'connected', 'qualified',
      'in_meeting', 'follow_up', 'proposal_sent', 'negotiation',
      'won', 'lost', 'on_hold'
    ));
