-- Migrate contacts.notes from TEXT to JSONB array of timestamped notes.
-- Each element: { "id": "uuid", "text": "...", "created_at": "ISO8601", "created_by": "email" }
-- Wrapped in a transaction to ensure all-or-nothing execution.

BEGIN;

-- 1. Add new JSONB column
ALTER TABLE contacts ADD COLUMN notes_json JSONB DEFAULT '[]'::jsonb;

-- 2. Migrate existing text notes into the new column
UPDATE contacts
SET notes_json = jsonb_build_array(
    jsonb_build_object(
        'id', gen_random_uuid()::text,
        'text', notes,
        'created_at', COALESCE(updated_at, now())::text,
        'created_by', 'system'
    )
)
WHERE notes IS NOT NULL AND notes != '';

-- 3. Drop old column and rename
ALTER TABLE contacts DROP COLUMN notes;
ALTER TABLE contacts RENAME COLUMN notes_json TO notes;

COMMIT;
