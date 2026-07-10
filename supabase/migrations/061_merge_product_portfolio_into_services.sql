-- ==========================================
-- Merge product_portfolio INTO product_services (data step)
-- ==========================================
-- Decision: product_services and product_portfolio held overlapping-but-distinct
-- category lists; we collapse them into a single product_services list.
--
-- This step ONLY rewrites data (safe to run while the current server is live —
-- product_portfolio is left in place and still readable). The column itself is
-- dropped in a later migration (062), AFTER code that stops referencing it ships.
--
-- Rules (mirrors server/src/lib/parseList.ts delimiters: ;  ,  |  newline):
--   * ONLY single-element arrays are re-split — those are the historical blobs
--     migration 050 wrapped whole (e.g. ["a, b, c"] -> ["a","b","c"]). This is the
--     per-tenant backfill that was never completed.
--   * Arrays that are ALREADY multi-element are treated as curated lists and kept
--     as-is (do NOT re-split), so legit elements with internal commas survive
--     (e.g. "Hazardous area motors (ATEX, Ex)" is not shattered).
--   * Both arrays are unioned (product_services first, then product_portfolio),
--     trimmed, empties dropped, deduped case-insensitively keeping the first
--     spelling; NULL when nothing usable remains.

UPDATE companies c
SET product_services = (
    SELECT array_agg(item ORDER BY ord)
    FROM (
        SELECT DISTINCT ON (lower(item)) item, ord
        FROM (
            SELECT btrim(elem) AS item, (base_ord * 1000 + eo) AS ord
            FROM (
                -- product_services elements (split only if the array is a single blob)
                SELECT elem, eo, 0 AS base_ord
                FROM unnest(coalesce(
                        CASE WHEN cardinality(c.product_services) = 1
                             THEN regexp_split_to_array(c.product_services[1], E'[;,|\n]+')
                             ELSE c.product_services END, '{}')) WITH ORDINALITY u(elem, eo)
                UNION ALL
                -- product_portfolio elements (same rule), ordered after services
                SELECT elem, eo, 100 AS base_ord
                FROM unnest(coalesce(
                        CASE WHEN cardinality(c.product_portfolio) = 1
                             THEN regexp_split_to_array(c.product_portfolio[1], E'[;,|\n]+')
                             ELSE c.product_portfolio END, '{}')) WITH ORDINALITY u(elem, eo)
            ) all_elems
            WHERE btrim(elem) <> ''
        ) parts
        ORDER BY lower(item), ord   -- DISTINCT ON keeps the smallest ord per spelling
    ) dedup
)
WHERE c.product_services IS NOT NULL OR c.product_portfolio IS NOT NULL;
