-- ==========================================
-- Atomic note operations for contacts.notes
-- Replaces read-modify-write pattern in application code that was
-- vulnerable to a race condition when two users appended/deleted notes
-- on the same contact concurrently.
-- ==========================================

-- Prepend a note to contacts.notes (newest-first ordering)
-- Returns the full updated notes array.
CREATE OR REPLACE FUNCTION append_contact_note(
    p_contact_id UUID,
    p_tenant_id  UUID,
    p_note       JSONB
)
RETURNS JSONB
LANGUAGE sql
AS $$
    UPDATE contacts
    SET    notes = jsonb_build_array(p_note) || COALESCE(notes, '[]'::jsonb)
    WHERE  id        = p_contact_id
      AND  tenant_id = p_tenant_id
    RETURNING notes;
$$;

-- Remove a note from contacts.notes by its id field
-- Returns the full updated notes array, or NULL if the contact was not found.
CREATE OR REPLACE FUNCTION remove_contact_note(
    p_contact_id UUID,
    p_tenant_id  UUID,
    p_note_id    TEXT
)
RETURNS JSONB
LANGUAGE sql
AS $$
    UPDATE contacts
    SET    notes = (
               SELECT COALESCE(jsonb_agg(n ORDER BY (n->>'created_at') DESC), '[]'::jsonb)
               FROM   jsonb_array_elements(COALESCE(notes, '[]'::jsonb)) AS n
               WHERE  n->>'id' <> p_note_id
           )
    WHERE  id        = p_contact_id
      AND  tenant_id = p_tenant_id
    RETURNING notes;
$$;
