-- Revoke direct execution of server-only RPC functions from public roles.
-- These functions are called via supabaseAdmin (service_role) from the server,
-- not directly by authenticated clients.

REVOKE EXECUTE ON FUNCTION append_contact_note(uuid, uuid, jsonb) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION remove_contact_note(uuid, uuid, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION get_contact_filter_options(uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION deactivate_pipeline_stage(uuid, text, jsonb, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION get_activity_type_counts(uuid, timestamptz, timestamptz, text, text, uuid, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION get_stage_counts(uuid, timestamptz, timestamptz) FROM anon, authenticated;
