-- ==========================================
-- Unified mail thread model (Faz 3 — plans/MAIL_THREAD_PLAN.md)
-- ------------------------------------------
-- Today conversations are grouped implicitly by (sender_email, campaign_id) on the
-- flat email_replies table. That key breaks when the replier != the campaign lead
-- (multi-person orgs, shared mailboxes) and can't unify Gmail/Outlook/IMAP threads.
--
-- This adds a real thread entity keyed by a channel-agnostic thread_key:
-- pv:{campaign}:{lead_id} / thr:{provider}:{id} / rfc:{msgid} / fb:{mailbox}:{subj}:{cp}.
-- email_replies stays the MESSAGE store and gains a nullable thread_id FK.
--
-- ADDITIVE + NON-BREAKING: new tables + one nullable column + a BEST-EFFORT dual-write
-- trigger. Nothing READS thread_id yet (dual-write phase); the read path switches later
-- behind a flag (Faz 4). Writes go through the service role, same posture as email_replies.
-- ==========================================

-- ── Threads ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mail_threads (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  thread_key         TEXT NOT NULL,
  channel            TEXT,
  provider_thread_id TEXT,
  campaign_id        TEXT,
  lead_id            TEXT,
  company_id         UUID REFERENCES companies(id) ON DELETE SET NULL,
  contact_id         UUID REFERENCES contacts(id) ON DELETE SET NULL,
  our_mailbox        TEXT,
  subject_norm       TEXT,
  last_message_at    TIMESTAMPTZ,
  last_direction     TEXT,
  unread_count       INT NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'open',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_mail_threads_tenant_key
  ON mail_threads (tenant_id, thread_key);
CREATE INDEX IF NOT EXISTS idx_mail_threads_tenant_last
  ON mail_threads (tenant_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_mail_threads_company
  ON mail_threads (company_id) WHERE company_id IS NOT NULL;

ALTER TABLE mail_threads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "mail_threads_select" ON mail_threads
  FOR SELECT USING (
    tenant_id = get_user_tenant_id() OR is_superadmin() OR get_user_role() = 'ops_agent'
  );

-- ── Participants (contact@ + younes both belong to one lead's thread) ──
CREATE TABLE IF NOT EXISTS mail_participants (
  thread_id   UUID NOT NULL REFERENCES mail_threads(id) ON DELETE CASCADE,
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,  -- denormalized for RLS
  address     TEXT NOT NULL,
  role        TEXT,                            -- lead | replier | our_mailbox | cc
  contact_id  UUID REFERENCES contacts(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, address)
);
CREATE INDEX IF NOT EXISTS idx_mail_participants_address
  ON mail_participants (tenant_id, address);

ALTER TABLE mail_participants ENABLE ROW LEVEL SECURITY;
CREATE POLICY "mail_participants_select" ON mail_participants
  FOR SELECT USING (
    tenant_id = get_user_tenant_id() OR is_superadmin() OR get_user_role() = 'ops_agent'
  );

-- ── Link messages → thread ──
ALTER TABLE email_replies
  ADD COLUMN IF NOT EXISTS thread_id UUID REFERENCES mail_threads(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_email_replies_thread
  ON email_replies (thread_id) WHERE thread_id IS NOT NULL;

-- ── Shared resolver: compute the thread for a message row, upsert mail_threads +
--    participants, RETURN the thread id. SECURITY DEFINER (privileged writes) +
--    BEST-EFFORT (returns NULL on any error → never breaks the caller). Used by BOTH
--    the insert trigger and the one-time backfill. Key logic MIRRORS
--    server/src/lib/mail/threadResolver.ts.
CREATE OR REPLACE FUNCTION mail_resolve_thread(p email_replies)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key text; v_lead text; v_subj text; v_ref text; v_id uuid;
BEGIN
  -- normalized subject (strip Re:/Fwd:/AW: … prefixes)
  v_subj := lower(btrim(regexp_replace(COALESCE(p.subject, ''),
    '^(\s*(re|fwd?|aw|antw|sv|vs|rv|res|tr|wg)\s*(\[[0-9]+\])?\s*:\s*)+', '', 'i')));

  -- 1. PlusVibe: (campaign, lead_id). OUT user-replies lack lead_id → inherit it
  --    from a sibling in the same (campaign, sender_email) conversation.
  IF p.provider = 'plusvibe' AND p.campaign_id IS NOT NULL THEN
    v_lead := p.plusvibe_lead_id;
    IF v_lead IS NULL THEN
      SELECT plusvibe_lead_id INTO v_lead FROM email_replies
        WHERE tenant_id = p.tenant_id AND campaign_id = p.campaign_id
          AND sender_email = p.sender_email AND plusvibe_lead_id IS NOT NULL
        LIMIT 1;
    END IF;
    IF v_lead IS NOT NULL THEN v_key := 'pv:' || p.campaign_id || ':' || v_lead; END IF;
  END IF;

  -- 2. Native provider thread id (gmail threadId / graph conversationId)
  IF v_key IS NULL AND p.provider_thread_id IS NOT NULL THEN
    v_key := 'thr:' || COALESCE(p.provider, '?') || ':' || p.provider_thread_id;
  END IF;

  -- 3. RFC chain: share the parent's key via in_reply_to; else own message-id
  IF v_key IS NULL AND p.in_reply_to IS NOT NULL THEN
    v_ref := (regexp_match(p.in_reply_to, '<([^>]+)>'))[1];
    IF v_ref IS NULL THEN v_ref := split_part(btrim(p.in_reply_to), ' ', 1); END IF;
    IF v_ref IS NOT NULL AND length(v_ref) > 0 THEN v_key := 'rfc:' || v_ref; END IF;
  END IF;
  IF v_key IS NULL AND p.rfc_message_id IS NOT NULL THEN
    v_key := 'rfc:' || p.rfc_message_id;
  END IF;

  -- 4. Fallback: mailbox + normalized subject + counterparty (sender_email)
  IF v_key IS NULL THEN
    v_key := 'fb:' || COALESCE(lower(p.account_email), '') || ':' || v_subj
             || ':' || lower(COALESCE(p.sender_email, ''));
  END IF;

  INSERT INTO mail_threads (
    tenant_id, thread_key, channel, provider_thread_id, campaign_id, lead_id,
    company_id, contact_id, our_mailbox, subject_norm, last_message_at, last_direction
  ) VALUES (
    p.tenant_id, v_key, p.provider, p.provider_thread_id, p.campaign_id, v_lead,
    p.company_id, p.contact_id, lower(p.account_email), NULLIF(v_subj, ''),
    p.replied_at, p.direction
  )
  ON CONFLICT (tenant_id, thread_key) DO UPDATE SET
    last_message_at = GREATEST(mail_threads.last_message_at, EXCLUDED.last_message_at),
    last_direction  = CASE WHEN EXCLUDED.last_message_at >= COALESCE(mail_threads.last_message_at, EXCLUDED.last_message_at)
                           THEN EXCLUDED.last_direction ELSE mail_threads.last_direction END,
    company_id         = COALESCE(mail_threads.company_id, EXCLUDED.company_id),
    contact_id         = COALESCE(mail_threads.contact_id, EXCLUDED.contact_id),
    our_mailbox        = COALESCE(mail_threads.our_mailbox, EXCLUDED.our_mailbox),
    lead_id            = COALESCE(mail_threads.lead_id, EXCLUDED.lead_id),
    provider_thread_id = COALESCE(mail_threads.provider_thread_id, EXCLUDED.provider_thread_id),
    channel            = COALESCE(mail_threads.channel, EXCLUDED.channel),
    subject_norm       = COALESCE(mail_threads.subject_norm, EXCLUDED.subject_norm),
    updated_at         = now()
  RETURNING id INTO v_id;

  -- participants (best-effort; first role wins)
  IF length(COALESCE(p.sender_email, '')) > 0 THEN
    INSERT INTO mail_participants (thread_id, tenant_id, address, role)
    VALUES (v_id, p.tenant_id, lower(p.sender_email),
            CASE WHEN p.direction = 'IN' THEN 'replier' ELSE 'lead' END)
    ON CONFLICT (thread_id, address) DO NOTHING;
  END IF;
  IF length(COALESCE(p.account_email, '')) > 0 THEN
    INSERT INTO mail_participants (thread_id, tenant_id, address, role)
    VALUES (v_id, p.tenant_id, lower(p.account_email), 'our_mailbox')
    ON CONFLICT (thread_id, address) DO NOTHING;
  END IF;

  RETURN v_id;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;  -- the thread model must never break the message write
END;
$$;

-- Dual-write: set thread_id on every email_replies INSERT.
CREATE OR REPLACE FUNCTION email_replies_link_thread()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.thread_id := mail_resolve_thread(NEW);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_email_replies_link_thread ON email_replies;
CREATE TRIGGER trg_email_replies_link_thread
  BEFORE INSERT ON email_replies
  FOR EACH ROW EXECUTE FUNCTION email_replies_link_thread();
