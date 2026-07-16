-- Part 0 (performance baseline): covering indexes for two hot, stable foreign
-- keys the Supabase performance advisor flagged as unindexed. Additive and
-- IF NOT EXISTS (safe, reversible, no data change).
--
--   companies.assigned_to  → backs the "assigned to me" filter/sort on Leads
--   activities.created_by  → backs creator lookups
--
-- The advisor flagged ~18 unindexed FKs in total. The rest are deferred to their
-- subsystem reviews on purpose: campaign_* → Part 5 (campaign engine), and
-- mail_threads/mail_participants/email_suppressions/email_replies → Part 7 (inbox),
-- which is actively being reshaped by the mail-thread migration work. Applied to
-- both prod and the test project.
CREATE INDEX IF NOT EXISTS idx_companies_assigned_to ON public.companies (assigned_to);
CREATE INDEX IF NOT EXISTS idx_activities_created_by ON public.activities (created_by);
