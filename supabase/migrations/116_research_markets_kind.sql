-- 116_research_markets_kind.sql
-- WP11 (UN Comtrade pivot): research_markets rows can now be either a world-import
-- ranking row (one row per candidate reporter country for an HS code) or a
-- bilateral-export row (seller country -> one candidate partner country). `kind`
-- discriminates the two; `reporter_country` (ISO2, e.g. 'TR') is only populated on
-- bilateral rows — the seller/exporter side of that bilateral query. RLS + triggers
-- already exist on research_markets from 056_research_icp_market.sql; nothing else
-- to add here.
ALTER TABLE research_markets
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'world_import' CHECK (kind IN ('world_import', 'bilateral_export')),
  ADD COLUMN reporter_country TEXT;
