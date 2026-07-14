-- ============================================================================
-- 143 — Per-role LLM model config (operator-editable model selection)
-- ============================================================================
-- The router (server/src/lib/research/llm/router.ts) binds each ROLE to a fixed
-- provider (strategy→Anthropic, search→Gemini, reading→DeepSeek — a K5/D16 design
-- decision, NOT operator-editable). The MODEL that provider runs, however, is a
-- per-call default that until now only came from env (RESEARCH_STRATEGY_MODEL etc).
-- This table lets a superadmin/ops_agent override the model per role at RUNTIME
-- from the admin COGS panel. Absent row → the env default still applies (so this
-- is purely additive: deleting a row reverts to env behavior).
--
-- Provider is intentionally NOT stored here — switching a role's provider stays a
-- code change. Only the model string is operator-tunable.
--
-- Additive + re-runnable. Values are validated against a curated catalog in the
-- API layer (server/src/lib/research/llm/llmConfig.ts) before write; the CHECK
-- here only guards the role key. service_role is the only writer (the admin API
-- uses researchSupabaseAdmin); direct client roles get nothing.

CREATE TABLE IF NOT EXISTS research_llm_config (
  role        TEXT PRIMARY KEY CHECK (role IN ('strategy', 'search', 'reading')),
  model       TEXT NOT NULL CHECK (length(btrim(model)) > 0 AND length(model) <= 120),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  UUID
);

COMMENT ON TABLE research_llm_config IS
  'Operator-editable per-role model override for the research LLM router. Absent role → env default (RESEARCH_{STRATEGY,SEARCH,READING}_MODEL). Provider stays fixed in code.';

-- RLS: this table is service-role-only. Enable RLS with NO permissive policy so
-- anon/authenticated get zero rows even if the anon key ever reaches it; the admin
-- API reads/writes it exclusively through the service-role client.
ALTER TABLE research_llm_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON research_llm_config FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON research_llm_config TO service_role;
