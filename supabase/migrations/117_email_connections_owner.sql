-- Tibexa Core CRM Expansion — email_connections owner mapping  [117]
-- Adds the user→mailbox column the sending-identity resolver has been waiting on
-- (sendingIdentity.ts personal_grade owner pin). ADDITIVE ONLY: no data touch, no
-- constraint on existing rows (§2.3.1 — email_connections DATA and the cold-email
-- send infra stay untouched; only the warm/read side reads this column).
--
-- owner_user_id maps a connected mailbox to the human who owns it, so a
-- personal-grade (1:1) send can leave AS that owner's real box. NULL = unowned
-- (shared / tenant-default box); a personal_grade send with an ownerUserId that
-- has no owned mailbox still fails closed (never drops to the brand identity).

ALTER TABLE email_connections
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- Owner lookup key: (tenant_id, owner_user_id) — the exact predicate the resolver
-- filters on when pinning an owner's box.
CREATE INDEX IF NOT EXISTS idx_email_connections_owner
  ON email_connections (tenant_id, owner_user_id);

COMMENT ON COLUMN email_connections.owner_user_id IS
  'The auth.users owner of this mailbox. NULL = unowned (shared / tenant-default). '
  'personal_grade sends resolve the owner''s own box via this column; absent a match they fail closed.';
