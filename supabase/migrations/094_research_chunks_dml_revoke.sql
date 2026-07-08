-- ==========================================
-- TG-Research v2 — WP3 hardening (codex P1)  [094]
--
-- research_update_chunk_coverage (091/093) is now the ONLY writer of research_chunks —
-- make that structural, like billing (066) / verdicts (069) / companies (072): revoke
-- direct DML so a bug or compromised service key cannot bypass the lease fence and
-- rewrite a cell's saturation record. Reads stay open (the coverage endpoint selects).
-- User-facing RLS policies from 056 remain for SELECT; client writes were never allowed
-- in practice (the module's writers are worker-only).
-- ==========================================

REVOKE INSERT, UPDATE, DELETE ON research_chunks FROM PUBLIC, anon, authenticated, service_role;
