-- ==========================================
-- 016: Add 'cold' stage and update default
-- ==========================================
-- Adds 'cold' as the new initial pipeline stage before 'in_queue'

-- Step 1: Drop old CHECK constraint
ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_stage_check;

-- Step 2: Set new default and add updated CHECK constraint with 'cold'
ALTER TABLE companies
  ALTER COLUMN stage SET DEFAULT 'cold',
  ADD CONSTRAINT companies_stage_check
    CHECK (stage IN (
      'cold', 'in_queue', 'first_contact', 'connected', 'qualified',
      'in_meeting', 'follow_up', 'proposal_sent', 'negotiation',
      'won', 'lost', 'on_hold'
    ));
