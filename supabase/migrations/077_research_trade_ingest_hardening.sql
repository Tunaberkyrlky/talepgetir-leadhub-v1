-- ==========================================
-- TG-Research v2 - Y2 trade ingest hardening
-- ------------------------------------------------------------------------------
-- Batch rows can carry internal worker/DB errors and commercially sensitive file
-- metadata. They are served through the tenant-scoped API, never direct PostgREST.
-- ==========================================

REVOKE SELECT, INSERT, UPDATE, DELETE ON research_trade_import_batches
  FROM PUBLIC, anon, authenticated;
