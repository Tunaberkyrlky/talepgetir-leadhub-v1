-- Tibexa CRM Expansion v3 — Phase 5 C4 conversation-memory HARDENING  [129]
-- Corrective DDL for 128_conversation_memory.sql (re-review: 2 P1 + 3 migration P2).
-- All three C4 tables (conversation_memory, memory_facts, generation_context_snapshots)
-- are BRAND-NEW with NO data and the rebuild/assemble/snapshot code is persist=false +
-- UNWIRED (no scheduler/tick, email node not wired). So altering constraints, replacing
-- trigger functions and tightening ON DELETE actions here is SAFE — nothing is persisted
-- to migrate and no live path deletes a referenced parent yet.
--
-- FILE-ONLY: do NOT apply from this worktree (same posture as 128). On the shared staging
-- DB the orchestrator applies it after 128; it only re-shapes 128's own objects.
--
-- What this fixes (all against 128):
--   P1a  generation_context_snapshots.selected_memory_fact_ids UUID[] was never tenant-fenced
--        — a tenant user could pin cross-tenant memory_fact ids. Now unnest+validated.
--   P1b  intra-C4 tenant consistency relied on ID-only FKs + non-locking EXISTS checks (a
--        parent tenant move / concurrent update could race). Now backed by composite
--        (tenant_id, <parent>) FKs (mirrors 126/076); external-parent checks take a FOR SHARE
--        row lock so a concurrent parent tenant move cannot race the insert-time validation.
--   P2c  snapshot immutability guarded only 7 generative columns and used ON DELETE SET NULL
--        for the audit links (a snapshot could be silently re-associated). Now EVERY column
--        except approval_state/human_edit_diff is frozen, and the links are ON DELETE RESTRICT.
--   P2d  memory_facts.superseded_by ON DELETE SET NULL resurrected an obsolete fact when its
--        replacement was deleted. Now ON DELETE RESTRICT (folded into the composite self-FK).

-- ── P1b/P2d: composite-key parents ────────────────────────────────────────────────
-- A composite (tenant_id, <parent_id>) FK needs a matching UNIQUE(tenant_id, id) on the
-- parent (id is already the PK; this companion unique lets the DB prove tenant ownership
-- through the FK — the 076/126 pattern). C4 parents get one each.
ALTER TABLE conversation_memory
  ADD CONSTRAINT uq_conversation_memory_tenant_id UNIQUE (tenant_id, id);
ALTER TABLE memory_facts
  ADD CONSTRAINT uq_memory_facts_tenant_id UNIQUE (tenant_id, id);

-- ── P1b/P2d: swap the intra-C4 ID-only FKs for tenant-composite FKs ────────────────
-- memory_facts.memory_id → conversation_memory(tenant_id, id): a fact can only back-link a
--   read-model in its OWN tenant. ON DELETE SET NULL (memory_id) nulls ONLY the back-link
--   (the column-list form — a bare SET NULL would try to null the NOT NULL tenant_id).
-- memory_facts.superseded_by → memory_facts(tenant_id, id): a supersession chain stays inside
--   one tenant. ON DELETE RESTRICT (P2d) so deleting a REPLACEMENT fact can no longer resurrect
--   the obsolete fact it superseded (current truth = superseded_by IS NULL).
ALTER TABLE memory_facts
  DROP CONSTRAINT IF EXISTS memory_facts_memory_id_fkey,
  DROP CONSTRAINT IF EXISTS memory_facts_superseded_by_fkey,
  ADD CONSTRAINT fk_memory_facts_memory
    FOREIGN KEY (tenant_id, memory_id)
    REFERENCES conversation_memory (tenant_id, id) ON DELETE SET NULL (memory_id),
  ADD CONSTRAINT fk_memory_facts_superseded
    FOREIGN KEY (tenant_id, superseded_by)
    REFERENCES memory_facts (tenant_id, id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

-- ── P1b/P2c: snapshot links become tenant-composite / RESTRICT ─────────────────────
-- memory_id → conversation_memory(tenant_id, id) composite FK, ON DELETE RESTRICT (an immutable
--   audit record must not lose its pinned memory association). message_id/automation_action_id/
--   lead_id reference tables WITHOUT a UNIQUE(tenant_id, id) (leads/messages/automation_actions
--   live in earlier migrations, so a cross-table composite FK cannot be created); their tenant
--   consistency stays enforced by the assert-tenant fence below (now FOR SHARE-locked). Their
--   ON DELETE flips SET NULL → RESTRICT so the immutable snapshot's associations are never
--   silently rewritten by deleting the parent (P2c).
-- M2: these four snapshot links AND fk_memory_facts_superseded are ON DELETE NO ACTION
--   DEFERRABLE INITIALLY DEFERRED. This MUST be NO ACTION, not RESTRICT: PostgreSQL never defers a
--   RESTRICT check (RESTRICT is "NO ACTION but not deferrable"), so `RESTRICT DEFERRABLE` silently
--   checks at statement time and would still break a whole-tenant cascade. With NO ACTION DEFERRED
--   the check runs at COMMIT: a standalone parent delete still fails (audit integrity preserved),
--   but a whole-tenant CASCADE (routes/admin.ts), which reaches leads/messages/automation_actions/
--   conversation_memory/memory_facts BEFORE the referencing snapshot/fact rows are removed in the
--   SAME transaction, no longer trips mid-cascade — by COMMIT the referencing rows are gone too.
--   fk_memory_facts_memory stays non-deferrable SET NULL (SET NULL never blocks a cascade).
ALTER TABLE generation_context_snapshots
  DROP CONSTRAINT IF EXISTS generation_context_snapshots_memory_id_fkey,
  DROP CONSTRAINT IF EXISTS generation_context_snapshots_message_id_fkey,
  DROP CONSTRAINT IF EXISTS generation_context_snapshots_automation_action_id_fkey,
  DROP CONSTRAINT IF EXISTS generation_context_snapshots_lead_id_fkey,
  ADD CONSTRAINT fk_gcs_memory
    FOREIGN KEY (tenant_id, memory_id)
    REFERENCES conversation_memory (tenant_id, id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT fk_gcs_message
    FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT fk_gcs_automation_action
    FOREIGN KEY (automation_action_id) REFERENCES automation_actions (id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT fk_gcs_lead
    FOREIGN KEY (lead_id) REFERENCES leads (id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

-- ── P1b: FOR SHARE-locked tenant fences for the EXTERNAL-parent refs ───────────────
-- The intra-C4 refs are now hard composite FKs (above), which also block moving a REFERENCED
-- C4 parent to another tenant. The refs to tables we cannot composite-FK (leads/contacts/
-- companies/messages/automation_actions) keep the SECURITY DEFINER EXISTS fence, but the
-- lookup now takes a FOR SHARE row lock on the referenced parent: a concurrent transaction
-- cannot change that parent's tenant_id between our check and our commit, closing the
-- insert-time TOCTOU race the re-review flagged. (The assert trigger already re-fires on
-- UPDATE OF tenant_id, so a later tenant_id change on a C4 row is re-validated too.)

CREATE OR REPLACE FUNCTION conversation_memory_assert_tenant()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.lead_id IS NOT NULL THEN
    PERFORM 1 FROM public.leads WHERE id = NEW.lead_id AND tenant_id = NEW.tenant_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'conversation_memory: lead % is not in tenant %', NEW.lead_id, NEW.tenant_id;
    END IF;
  END IF;
  IF NEW.contact_id IS NOT NULL THEN
    PERFORM 1 FROM public.contacts WHERE id = NEW.contact_id AND tenant_id = NEW.tenant_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'conversation_memory: contact % is not in tenant %', NEW.contact_id, NEW.tenant_id;
    END IF;
  END IF;
  IF NEW.company_id IS NOT NULL THEN
    PERFORM 1 FROM public.companies WHERE id = NEW.company_id AND tenant_id = NEW.tenant_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'conversation_memory: company % is not in tenant %', NEW.company_id, NEW.tenant_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION memory_facts_assert_tenant()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- memory_id / superseded_by are now enforced by composite FKs; the lead_id ref is external
  -- (no UNIQUE(tenant_id,id) to composite-FK against) so it keeps the fence, now FOR SHARE-locked.
  IF NEW.lead_id IS NOT NULL THEN
    PERFORM 1 FROM public.leads WHERE id = NEW.lead_id AND tenant_id = NEW.tenant_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'memory_facts: lead % is not in tenant %', NEW.lead_id, NEW.tenant_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
-- lead_id is the only column this fence still needs (memory_id/superseded_by = composite FK).
DROP TRIGGER IF EXISTS memory_facts_tenant_consistency ON memory_facts;
CREATE TRIGGER memory_facts_tenant_consistency
  BEFORE INSERT OR UPDATE OF tenant_id, lead_id ON memory_facts
  FOR EACH ROW EXECUTE FUNCTION memory_facts_assert_tenant();

-- ── P1a: tenant-fence selected_memory_fact_ids + external refs FOR SHARE-locked ────
-- The UUID[] of pinned facts was never validated: a tenant user could stuff another tenant's
-- memory_fact ids into a snapshot. Unnest it and reject any id that is not a memory_facts row
-- in the SAME tenant. message_id/automation_action_id/lead_id are external refs (RESTRICT FK
-- above, no composite), so their fence stays and is now FOR SHARE-locked; memory_id is a
-- composite FK so its EXISTS check is kept only as cheap defense in depth.
CREATE OR REPLACE FUNCTION generation_context_snapshots_assert_tenant()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_fid uuid;
BEGIN
  IF NEW.message_id IS NOT NULL THEN
    PERFORM 1 FROM public.messages WHERE id = NEW.message_id AND tenant_id = NEW.tenant_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'generation_context_snapshots: message % is not in tenant %', NEW.message_id, NEW.tenant_id;
    END IF;
  END IF;
  IF NEW.automation_action_id IS NOT NULL THEN
    PERFORM 1 FROM public.automation_actions WHERE id = NEW.automation_action_id AND tenant_id = NEW.tenant_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'generation_context_snapshots: automation_action % is not in tenant %', NEW.automation_action_id, NEW.tenant_id;
    END IF;
  END IF;
  IF NEW.lead_id IS NOT NULL THEN
    PERFORM 1 FROM public.leads WHERE id = NEW.lead_id AND tenant_id = NEW.tenant_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'generation_context_snapshots: lead % is not in tenant %', NEW.lead_id, NEW.tenant_id;
    END IF;
  END IF;
  IF NEW.memory_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.conversation_memory WHERE id = NEW.memory_id AND tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'generation_context_snapshots: memory % is not in tenant %', NEW.memory_id, NEW.tenant_id;
  END IF;
  -- P1a (M1): every pinned fact id must be a memory_facts row in the SAME tenant, row-locked
  -- FOR SHARE for the length of THIS transaction — so a concurrent fact delete or tenant_id move
  -- cannot commit between this validation and ours and leave a dangling / cross-tenant id on an
  -- immutable snapshot. A locking clause cannot ride an aggregate (unnest+NOT EXISTS), so lock each
  -- id individually in a PERFORM loop.
  IF NEW.selected_memory_fact_ids IS NOT NULL THEN
    -- Bound the per-row work: the app pins <=50 facts, so an RLS-authorized direct INSERT with a
    -- huge/duplicated array cannot turn this per-id FOR SHARE loop into a CPU/lock amplifier.
    IF cardinality(NEW.selected_memory_fact_ids) > 50 THEN
      RAISE EXCEPTION 'generation_context_snapshots: selected_memory_fact_ids exceeds the 50-id limit (got %)', cardinality(NEW.selected_memory_fact_ids);
    END IF;
    FOREACH v_fid IN ARRAY NEW.selected_memory_fact_ids LOOP
      PERFORM 1 FROM public.memory_facts mf
        WHERE mf.id = v_fid AND mf.tenant_id = NEW.tenant_id
        FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'generation_context_snapshots: selected_memory_fact_id % is not in tenant %', v_fid, NEW.tenant_id;
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
-- selected_memory_fact_ids joins the UPDATE OF list so a later edit is re-fenced (the
-- immutability trigger already blocks such an edit, but this keeps the fence self-contained).
DROP TRIGGER IF EXISTS generation_context_snapshots_tenant_consistency ON generation_context_snapshots;
CREATE TRIGGER generation_context_snapshots_tenant_consistency
  BEFORE INSERT OR UPDATE OF tenant_id, message_id, automation_action_id, lead_id, memory_id, selected_memory_fact_ids
  ON generation_context_snapshots
  FOR EACH ROW EXECUTE FUNCTION generation_context_snapshots_assert_tenant();

-- ── P2c: full snapshot immutability (only approval_state + human_edit_diff mutable) ─
-- 128 froze just 7 generative columns, leaving tenant_id/message_id/automation_action_id/
-- lead_id/memory_id/id/created_at mutable — a written snapshot could be reassigned to another
-- message/lead/tenant after the fact, defeating the audit guarantee. Freeze EVERY column and
-- allow ONLY the two human-decision columns to change, and fire on EVERY update (no OF list).
CREATE OR REPLACE FUNCTION generation_context_snapshots_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id                        IS DISTINCT FROM OLD.id
     OR NEW.tenant_id              IS DISTINCT FROM OLD.tenant_id
     OR NEW.message_id             IS DISTINCT FROM OLD.message_id
     OR NEW.automation_action_id   IS DISTINCT FROM OLD.automation_action_id
     OR NEW.lead_id                IS DISTINCT FROM OLD.lead_id
     OR NEW.memory_id              IS DISTINCT FROM OLD.memory_id
     OR NEW.prompt_recipe_version  IS DISTINCT FROM OLD.prompt_recipe_version
     OR NEW.selected_memory_fact_ids IS DISTINCT FROM OLD.selected_memory_fact_ids
     OR NEW.recent_turns           IS DISTINCT FROM OLD.recent_turns
     OR NEW.meeting_summary_version IS DISTINCT FROM OLD.meeting_summary_version
     OR NEW.asset_engagement       IS DISTINCT FROM OLD.asset_engagement
     OR NEW.open_commitments       IS DISTINCT FROM OLD.open_commitments
     OR NEW.generated_message      IS DISTINCT FROM OLD.generated_message
     OR NEW.created_at             IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'generation_context_snapshots: only approval_state and human_edit_diff are mutable once written';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS generation_context_snapshots_immutable ON generation_context_snapshots;
CREATE TRIGGER generation_context_snapshots_immutable
  BEFORE UPDATE ON generation_context_snapshots
  FOR EACH ROW EXECUTE FUNCTION generation_context_snapshots_immutable();
