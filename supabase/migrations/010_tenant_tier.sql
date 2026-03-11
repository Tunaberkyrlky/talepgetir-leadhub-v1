-- Add tier column to tenants table for package-level feature gating
-- 'basic' = limited features, 'pro' = full features
-- Internal roles (superadmin, ops_agent) are tier-exempt
ALTER TABLE tenants ADD COLUMN tier TEXT NOT NULL DEFAULT 'basic' CHECK (tier IN ('basic', 'pro'));

-- Index for efficient tier-based queries
CREATE INDEX idx_tenants_tier ON tenants(tier);
