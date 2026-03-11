-- Add linkedin column to contacts table
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS linkedin TEXT;
