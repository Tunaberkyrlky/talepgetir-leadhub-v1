-- Cold Call atomicity/security hardening (forward-only; 20260714173500 tabanı uygulanmış olabilir).

ALTER TABLE coldcall_calls
  ADD COLUMN IF NOT EXISTS origin_country_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS destination_country_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS destination_type_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS pstn_rate_usd_snapshot NUMERIC(10,6),
  ADD COLUMN IF NOT EXISTS recording_enabled_snapshot BOOLEAN;

-- Legacy/in-flight rows predate snapshots. Seed conservative immutable values so
-- a call already in progress can still finalize after this forward migration.
UPDATE coldcall_calls c SET
  origin_country_snapshot=COALESCE(c.origin_country_snapshot,n.country_code),
  destination_country_snapshot=COALESCE(c.destination_country_snapshot,c.to_country),
  destination_type_snapshot=COALESCE(c.destination_type_snapshot,'unknown'),
  pstn_rate_usd_snapshot=COALESCE(c.pstn_rate_usd_snapshot,GREATEST(c.rate_multiplier*0.03,0.03)),
  recording_enabled_snapshot=COALESCE(c.recording_enabled_snapshot,true)
FROM coldcall_phone_numbers n
WHERE c.phone_number_id=n.id AND (
  c.origin_country_snapshot IS NULL OR c.destination_country_snapshot IS NULL OR
  c.destination_type_snapshot IS NULL OR c.pstn_rate_usd_snapshot IS NULL OR
  c.recording_enabled_snapshot IS NULL
);

ALTER TABLE coldcall_settings
  ADD COLUMN IF NOT EXISTS provisioning_state TEXT NOT NULL DEFAULT 'idle',
  ADD COLUMN IF NOT EXISTS provisioning_claim UUID,
  ADD COLUMN IF NOT EXISTS provisioning_claimed_at TIMESTAMPTZ;

ALTER TABLE coldcall_credit_ledger ADD COLUMN IF NOT EXISTS payload_fingerprint TEXT;
DROP FUNCTION IF EXISTS coldcall_deduct_minutes(UUID,NUMERIC,UUID,TEXT);
DROP FUNCTION IF EXISTS coldcall_pending_usage_calls(UUID);
DROP FUNCTION IF EXISTS coldcall_grant_minutes(UUID,NUMERIC,TEXT,TEXT,UUID,TEXT,TEXT);
DROP INDEX IF EXISTS idx_coldcall_ledger_idem;
CREATE UNIQUE INDEX IF NOT EXISTS idx_coldcall_ledger_tenant_idem
  ON coldcall_credit_ledger(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

WITH ranked_recordings AS (
  SELECT id,row_number() OVER(PARTITION BY provider_recording_sid ORDER BY created_at DESC,id DESC) AS duplicate_rank
  FROM coldcall_recordings WHERE provider_recording_sid IS NOT NULL
)
UPDATE coldcall_recordings r SET provider_recording_sid=NULL
FROM ranked_recordings d WHERE r.id=d.id AND d.duplicate_rank>1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_coldcall_recordings_provider_sid
  ON coldcall_recordings(provider_recording_sid) WHERE provider_recording_sid IS NOT NULL;

ALTER TABLE coldcall_recordings
  ADD COLUMN IF NOT EXISTS recording_source_url TEXT,
  ADD COLUMN IF NOT EXISTS queue_status TEXT NOT NULL DEFAULT 'completed',
  ADD COLUMN IF NOT EXISTS queue_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS queue_next_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS queue_lease_token UUID,
  ADD COLUMN IF NOT EXISTS queue_lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS queue_last_error TEXT,
  ADD COLUMN IF NOT EXISTS queue_completed_at TIMESTAMPTZ;
ALTER TABLE coldcall_recordings DROP CONSTRAINT IF EXISTS coldcall_recordings_queue_status_check;
ALTER TABLE coldcall_recordings ADD CONSTRAINT coldcall_recordings_queue_status_check
  CHECK(queue_status IN ('pending','leased','failed','completed'));
CREATE INDEX IF NOT EXISTS idx_coldcall_recordings_queue
  ON coldcall_recordings(queue_next_attempt_at,created_at)
  WHERE queue_status IN ('pending','failed','leased');

ALTER TABLE coldcall_phone_numbers DROP CONSTRAINT IF EXISTS coldcall_phone_numbers_status_check;
ALTER TABLE coldcall_phone_numbers ADD CONSTRAINT coldcall_phone_numbers_status_check
  CHECK (status IN ('purchasing','purchase_unknown','release_pending','pending_regulatory','active','released'));
ALTER TABLE coldcall_phone_numbers
  ADD COLUMN IF NOT EXISTS cleanup_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cleanup_next_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cleanup_lease_token UUID,
  ADD COLUMN IF NOT EXISTS cleanup_lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cleanup_last_error TEXT;

CREATE OR REPLACE FUNCTION coldcall_start_call(
  p_tenant_id UUID, p_company_id UUID, p_contact_id UUID, p_user_id UUID,
  p_phone_number_id UUID, p_from_e164 TEXT, p_to_e164 TEXT, p_to_country TEXT,
  p_rate_multiplier NUMERIC, p_origin_country TEXT, p_destination_country TEXT,
  p_destination_type TEXT, p_pstn_rate_usd NUMERIC, p_recording_enabled BOOLEAN
) RETURNS coldcall_calls LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_call coldcall_calls; v_balance NUMERIC;
BEGIN
  SELECT minutes_balance INTO v_balance FROM coldcall_settings
    WHERE tenant_id = p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'coldcall_settings_missing' USING ERRCODE='P0002'; END IF;
  IF v_balance <= 0 THEN RAISE EXCEPTION 'coldcall_balance_exhausted' USING ERRCODE='P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM coldcall_phone_numbers WHERE id=p_phone_number_id
                 AND tenant_id=p_tenant_id AND status='active' AND e164=p_from_e164) THEN
    RAISE EXCEPTION 'coldcall_number_invalid' USING ERRCODE='P0001';
  END IF;
  INSERT INTO coldcall_calls(
    tenant_id,company_id,contact_id,user_id,phone_number_id,direction,from_e164,to_e164,
    to_country,status,rate_multiplier,origin_country_snapshot,destination_country_snapshot,
    destination_type_snapshot,pstn_rate_usd_snapshot,recording_enabled_snapshot
  ) VALUES (
    p_tenant_id,p_company_id,p_contact_id,p_user_id,p_phone_number_id,'outbound',p_from_e164,p_to_e164,
    p_to_country,'queued',p_rate_multiplier,p_origin_country,p_destination_country,
    p_destination_type,p_pstn_rate_usd,p_recording_enabled
  ) RETURNING * INTO v_call;
  RETURN v_call;
END; $$;

CREATE OR REPLACE FUNCTION coldcall_finalize_call(
  p_tenant_id UUID, p_call_id UUID, p_status TEXT, p_answered_at TIMESTAMPTZ,
  p_ended_at TIMESTAMPTZ, p_duration_sec INTEGER, p_billed_minutes NUMERIC,
  p_cogs_usd NUMERIC
) RETURNS coldcall_calls LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_call coldcall_calls; v_new NUMERIC; v_expected_billed NUMERIC;
BEGIN
  PERFORM 1 FROM coldcall_settings WHERE tenant_id=p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'coldcall_settings_missing' USING ERRCODE='P0002'; END IF;
  SELECT * INTO v_call FROM coldcall_calls WHERE id=p_call_id AND tenant_id=p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'coldcall_call_not_found' USING ERRCODE='P0002'; END IF;
  v_expected_billed := CASE WHEN p_status='completed' AND COALESCE(p_duration_sec,0)>0
    THEN ceil(p_duration_sec::NUMERIC/60)*v_call.rate_multiplier ELSE 0 END;
  IF COALESCE(p_billed_minutes,0) <> v_expected_billed THEN
    RAISE EXCEPTION 'coldcall_billed_minutes_mismatch' USING ERRCODE='P0001';
  END IF;
  IF v_call.status IN ('completed','busy','no_answer','failed','canceled') THEN
    IF v_call.status <> p_status OR COALESCE(v_call.billed_minutes,0) <> COALESCE(p_billed_minutes,0)
       OR COALESCE(v_call.duration_sec,0) <> COALESCE(p_duration_sec,0) THEN
      RAISE EXCEPTION 'coldcall_finalize_payload_mismatch' USING ERRCODE='P0001';
    END IF;
    RETURN v_call;
  END IF;
  UPDATE coldcall_calls SET status=p_status, answered_at=p_answered_at, ended_at=p_ended_at,
    duration_sec=p_duration_sec, billed_minutes=p_billed_minutes, cogs_usd=p_cogs_usd
    WHERE id=p_call_id RETURNING * INTO v_call;
  IF v_call.status='completed' AND COALESCE(v_call.billed_minutes,0)>0 THEN
    UPDATE coldcall_settings SET minutes_balance=minutes_balance-v_call.billed_minutes,updated_at=now()
      WHERE tenant_id=p_tenant_id RETURNING minutes_balance INTO v_new;
    INSERT INTO coldcall_credit_ledger(tenant_id,delta_minutes,kind,balance_after,call_id,source,reason)
      VALUES(p_tenant_id,-v_call.billed_minutes,'usage',v_new,p_call_id,'system','call')
      ON CONFLICT (call_id) WHERE kind='usage' DO NOTHING;
  END IF;
  RETURN v_call;
END; $$;

CREATE OR REPLACE FUNCTION coldcall_reconcile_usage(p_limit INTEGER DEFAULT 100) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r RECORD; v_new NUMERIC; v_count INTEGER:=0;
BEGIN
  FOR r IN SELECT c.id,c.tenant_id,c.billed_minutes FROM coldcall_calls c
    WHERE c.status='completed' AND COALESCE(c.billed_minutes,0)>0
      AND NOT EXISTS(SELECT 1 FROM coldcall_credit_ledger l WHERE l.call_id=c.id AND l.kind='usage')
    ORDER BY c.created_at
    LIMIT LEAST(GREATEST(p_limit,1),1000)
  LOOP
    PERFORM 1 FROM coldcall_settings WHERE tenant_id=r.tenant_id FOR UPDATE;
    INSERT INTO coldcall_credit_ledger(tenant_id,delta_minutes,kind,balance_after,call_id,source,reason)
      VALUES(r.tenant_id,-r.billed_minutes,'usage',0,r.id,'system','reconciliation')
      ON CONFLICT (call_id) WHERE kind='usage' DO NOTHING;
    IF FOUND THEN
      UPDATE coldcall_settings SET minutes_balance=minutes_balance-r.billed_minutes,updated_at=now()
        WHERE tenant_id=r.tenant_id RETURNING minutes_balance INTO v_new;
      UPDATE coldcall_credit_ledger SET balance_after=v_new WHERE call_id=r.id AND kind='usage';
      v_count:=v_count+1;
    END IF;
  END LOOP;
  RETURN v_count;
END; $$;

CREATE OR REPLACE FUNCTION coldcall_claim_provisioning(p_tenant_id UUID,p_claim UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  UPDATE coldcall_settings SET provisioning_state='provisioning',provisioning_claim=p_claim,
    provisioning_claimed_at=now(),updated_at=now()
  WHERE tenant_id=p_tenant_id AND (
    provisioning_state='idle' OR provisioning_state='failed' OR
    provisioning_claimed_at < now()-interval '15 minutes'
  );
  RETURN FOUND;
END; $$;

CREATE OR REPLACE FUNCTION coldcall_finish_provisioning(p_tenant_id UUID,p_claim UUID,p_success BOOLEAN)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  UPDATE coldcall_settings SET provisioning_state=CASE WHEN p_success THEN 'complete' ELSE 'failed' END,
    provisioning_claim=NULL,provisioning_claimed_at=NULL,updated_at=now()
  WHERE tenant_id=p_tenant_id AND provisioning_claim=p_claim;
  RETURN FOUND;
END; $$;

CREATE OR REPLACE FUNCTION coldcall_assert_provisioning_claim(p_tenant_id UUID,p_claim UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT EXISTS(SELECT 1 FROM coldcall_settings WHERE tenant_id=p_tenant_id
   AND provisioning_state='provisioning' AND provisioning_claim=p_claim
   AND provisioning_claimed_at>=now()-interval '15 minutes');
$$;

CREATE OR REPLACE FUNCTION coldcall_persist_provisioning(
 p_tenant_id UUID,p_claim UUID,p_subaccount_sid TEXT,p_api_key_sid TEXT,
 p_api_key_secret_enc TEXT,p_twiml_app_sid TEXT,p_webhook_secret TEXT,p_complete BOOLEAN
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 UPDATE coldcall_settings SET
   subaccount_sid=COALESCE(p_subaccount_sid,subaccount_sid),
   api_key_sid=COALESCE(p_api_key_sid,api_key_sid),
   api_key_secret_enc=COALESCE(p_api_key_secret_enc,api_key_secret_enc),
   twiml_app_sid=COALESCE(p_twiml_app_sid,twiml_app_sid),
   webhook_secret=COALESCE(p_webhook_secret,webhook_secret),
   provider=CASE WHEN p_complete THEN 'twilio' ELSE provider END,updated_at=now()
 WHERE tenant_id=p_tenant_id AND provisioning_state='provisioning'
   AND provisioning_claim=p_claim AND provisioning_claimed_at>=now()-interval '15 minutes';
 RETURN FOUND;
END; $$;

CREATE OR REPLACE FUNCTION coldcall_reserve_number(
 p_tenant_id UUID,p_provider TEXT,p_e164 TEXT,p_country TEXT,p_monthly NUMERIC,p_created_by UUID
) RETURNS coldcall_phone_numbers LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_max INTEGER; v_num coldcall_phone_numbers;
BEGIN
 SELECT max_numbers INTO v_max FROM coldcall_settings WHERE tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'coldcall_settings_missing'; END IF;
 IF (SELECT count(*) FROM coldcall_phone_numbers WHERE tenant_id=p_tenant_id AND status<>'released')>=v_max
   THEN RAISE EXCEPTION 'coldcall_number_quota'; END IF;
 INSERT INTO coldcall_phone_numbers(tenant_id,provider,e164,country_code,friendly_name,status,
   monthly_cost_usd,created_by,cleanup_attempts,cleanup_next_attempt_at,
   cleanup_lease_token,cleanup_lease_expires_at)
 VALUES(p_tenant_id,p_provider,p_e164,upper(p_country),p_e164,'purchasing',p_monthly,p_created_by,
   0,now()+interval '15 minutes',NULL,NULL)
 ON CONFLICT(tenant_id,e164) DO UPDATE SET provider=EXCLUDED.provider,country_code=EXCLUDED.country_code,
   friendly_name=EXCLUDED.friendly_name,status='purchasing',monthly_cost_usd=EXCLUDED.monthly_cost_usd,
   created_by=EXCLUDED.created_by,provider_sid=NULL,released_at=NULL,
   cleanup_attempts=0,cleanup_next_attempt_at=now()+interval '15 minutes',cleanup_last_error=NULL,
   cleanup_lease_token=NULL,cleanup_lease_expires_at=NULL
 WHERE coldcall_phone_numbers.status='released'
 RETURNING * INTO v_num;
 IF NOT FOUND THEN RAISE EXCEPTION 'coldcall_number_already_reserved'; END IF;
 RETURN v_num;
END; $$;

CREATE OR REPLACE FUNCTION coldcall_complete_number(
 p_tenant_id UUID,p_number_id UUID,p_provider_sid TEXT,p_status TEXT,p_e164 TEXT
) RETURNS coldcall_phone_numbers LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_num coldcall_phone_numbers;
BEGIN
 UPDATE coldcall_phone_numbers SET provider_sid=p_provider_sid,e164=p_e164,friendly_name=p_e164,status=p_status,
   purchased_at=now(),cleanup_attempts=0,cleanup_next_attempt_at=NULL,cleanup_last_error=NULL,
   cleanup_lease_token=NULL,cleanup_lease_expires_at=NULL
   WHERE id=p_number_id AND tenant_id=p_tenant_id AND status='purchasing'
   RETURNING * INTO v_num;
 IF NOT FOUND THEN RAISE EXCEPTION 'coldcall_number_reservation_missing'; END IF;
 RETURN v_num;
END; $$;

CREATE OR REPLACE FUNCTION coldcall_release_number_reservation(p_tenant_id UUID,p_number_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 UPDATE coldcall_phone_numbers SET status='released',released_at=now(),cleanup_attempts=0,
   cleanup_next_attempt_at=NULL,cleanup_last_error=NULL,cleanup_lease_token=NULL,
   cleanup_lease_expires_at=NULL
 WHERE id=p_number_id AND tenant_id=p_tenant_id AND status='purchasing';
 RETURN FOUND;
END; $$;

CREATE OR REPLACE FUNCTION coldcall_mark_number_cleanup(
 p_tenant_id UUID,p_number_id UUID,p_provider_sid TEXT,p_error TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 UPDATE coldcall_phone_numbers SET status='release_pending',provider_sid=p_provider_sid,
   cleanup_next_attempt_at=now(),cleanup_last_error=left(COALESCE(p_error,'release failed'),2000)
 WHERE id=p_number_id AND tenant_id=p_tenant_id AND status='purchasing';
 RETURN FOUND;
END; $$;

CREATE OR REPLACE FUNCTION coldcall_claim_explicit_number_release(p_tenant_id UUID,p_number_id UUID)
RETURNS coldcall_phone_numbers LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_num coldcall_phone_numbers;
BEGIN
 UPDATE coldcall_phone_numbers SET status='release_pending',cleanup_attempts=0,
   cleanup_next_attempt_at=now()+interval '5 minutes',cleanup_last_error='explicit release in progress',
   cleanup_lease_token=NULL,cleanup_lease_expires_at=NULL
 WHERE id=p_number_id AND tenant_id=p_tenant_id AND status IN ('active','pending_regulatory')
 RETURNING * INTO v_num;
 IF NOT FOUND THEN RAISE EXCEPTION 'coldcall_number_not_releasable'; END IF;
 RETURN v_num;
END; $$;

CREATE OR REPLACE FUNCTION coldcall_complete_explicit_number_release(p_tenant_id UUID,p_number_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_tenant_id UUID;
BEGIN
 SELECT tenant_id INTO v_tenant_id FROM coldcall_phone_numbers
 WHERE id=p_number_id AND tenant_id=p_tenant_id;
 IF v_tenant_id IS NULL THEN RETURN FALSE; END IF;
 PERFORM 1 FROM coldcall_settings WHERE tenant_id=v_tenant_id FOR UPDATE;
 UPDATE coldcall_phone_numbers SET status='released',released_at=now(),cleanup_attempts=0,
   cleanup_next_attempt_at=NULL,cleanup_last_error=NULL,cleanup_lease_token=NULL,
   cleanup_lease_expires_at=NULL
 WHERE id=p_number_id AND tenant_id=p_tenant_id AND status='release_pending'
   AND cleanup_lease_token IS NULL
 RETURNING tenant_id INTO v_tenant_id;
 IF NOT FOUND THEN RETURN FALSE; END IF;
 UPDATE coldcall_settings SET default_phone_number_id=NULL,updated_at=now()
 WHERE tenant_id=v_tenant_id AND default_phone_number_id=p_number_id;
 RETURN TRUE;
END; $$;

CREATE OR REPLACE FUNCTION coldcall_mark_number_ambiguous(p_tenant_id UUID,p_number_id UUID,p_error TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 UPDATE coldcall_phone_numbers SET status='purchase_unknown',cleanup_next_attempt_at=now(),
   cleanup_last_error=left(COALESCE(p_error,'purchase outcome unknown'),2000)
 WHERE id=p_number_id AND tenant_id=p_tenant_id AND status='purchasing';
 RETURN FOUND;
END; $$;

CREATE OR REPLACE FUNCTION coldcall_claim_number_cleanup(p_lease UUID,p_seconds INTEGER DEFAULT 300)
RETURNS SETOF coldcall_phone_numbers LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_id UUID;
BEGIN
 UPDATE coldcall_phone_numbers SET status='purchase_unknown',
   cleanup_next_attempt_at=now(),cleanup_last_error='stale purchasing reservation'
 WHERE status='purchasing' AND cleanup_next_attempt_at IS NOT NULL
   AND cleanup_next_attempt_at<=now();
 SELECT id INTO v_id FROM coldcall_phone_numbers WHERE status IN ('release_pending','purchase_unknown') AND cleanup_attempts<12
  AND ((cleanup_lease_token IS NULL AND COALESCE(cleanup_next_attempt_at,now())<=now())
    OR cleanup_lease_expires_at<now())
  ORDER BY cleanup_next_attempt_at NULLS FIRST,purchased_at FOR UPDATE SKIP LOCKED LIMIT 1;
 IF v_id IS NULL THEN RETURN; END IF;
 RETURN QUERY UPDATE coldcall_phone_numbers SET cleanup_attempts=cleanup_attempts+1,
   cleanup_lease_token=p_lease,cleanup_lease_expires_at=now()+make_interval(secs=>LEAST(GREATEST(p_seconds,30),900))
  WHERE id=v_id RETURNING *;
END; $$;

CREATE OR REPLACE FUNCTION coldcall_finish_number_cleanup(
 p_number_id UUID,p_lease UUID,p_success BOOLEAN,p_error TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_tenant_id UUID;
BEGIN
 SELECT tenant_id INTO v_tenant_id FROM coldcall_phone_numbers WHERE id=p_number_id;
 IF v_tenant_id IS NULL THEN RETURN FALSE; END IF;
 PERFORM 1 FROM coldcall_settings WHERE tenant_id=v_tenant_id FOR UPDATE;
 UPDATE coldcall_phone_numbers SET status=CASE WHEN p_success THEN 'released' ELSE status END,
  released_at=CASE WHEN p_success THEN now() ELSE released_at END,
  cleanup_next_attempt_at=CASE WHEN p_success THEN NULL ELSE now()+interval '5 minutes' END,
  cleanup_last_error=CASE WHEN p_success THEN NULL ELSE left(COALESCE(p_error,'release failed'),2000) END,
  cleanup_attempts=CASE WHEN p_success THEN 0 ELSE cleanup_attempts END,
  cleanup_lease_token=NULL,cleanup_lease_expires_at=NULL
 WHERE id=p_number_id AND status='release_pending' AND cleanup_lease_token=p_lease
 RETURNING tenant_id INTO v_tenant_id;
 IF NOT FOUND THEN RETURN FALSE; END IF;
 IF p_success THEN
   UPDATE coldcall_settings SET default_phone_number_id=NULL,updated_at=now()
   WHERE tenant_id=v_tenant_id AND default_phone_number_id=p_number_id;
 END IF;
 RETURN TRUE;
END; $$;

CREATE OR REPLACE FUNCTION coldcall_finish_number_reconciliation(
 p_number_id UUID,p_lease UUID,p_owned BOOLEAN,p_provider_sid TEXT,p_error TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_tenant_id UUID;
BEGIN
 SELECT tenant_id INTO v_tenant_id FROM coldcall_phone_numbers WHERE id=p_number_id;
 IF v_tenant_id IS NULL THEN RETURN FALSE; END IF;
 PERFORM 1 FROM coldcall_settings WHERE tenant_id=v_tenant_id FOR UPDATE;
 UPDATE coldcall_phone_numbers SET
  status=CASE WHEN p_error IS NOT NULL THEN status WHEN p_owned THEN 'active' ELSE 'released' END,
  provider_sid=CASE WHEN p_owned THEN p_provider_sid ELSE provider_sid END,
  released_at=CASE WHEN p_error IS NULL AND NOT p_owned THEN now() ELSE released_at END,
  cleanup_next_attempt_at=CASE WHEN p_error IS NULL THEN NULL ELSE now()+interval '5 minutes' END,
  cleanup_last_error=CASE WHEN p_error IS NULL THEN NULL ELSE left(p_error,2000) END,
  cleanup_attempts=CASE WHEN p_error IS NULL THEN 0 ELSE cleanup_attempts END,
  cleanup_lease_token=NULL,cleanup_lease_expires_at=NULL
 WHERE id=p_number_id AND status='purchase_unknown' AND cleanup_lease_token=p_lease
 RETURNING tenant_id INTO v_tenant_id;
 IF NOT FOUND THEN RETURN FALSE; END IF;
 IF p_error IS NULL AND NOT p_owned THEN
   UPDATE coldcall_settings SET default_phone_number_id=NULL,updated_at=now()
   WHERE tenant_id=v_tenant_id AND default_phone_number_id=p_number_id;
 END IF;
 RETURN TRUE;
END; $$;

CREATE OR REPLACE FUNCTION coldcall_enqueue_recording(
 p_tenant_id UUID,p_call_id UUID,p_provider_sid TEXT,p_source_url TEXT,p_duration INTEGER
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_id UUID;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM coldcall_calls WHERE id=p_call_id AND tenant_id=p_tenant_id)
   THEN RAISE EXCEPTION 'coldcall_call_not_found'; END IF;
 INSERT INTO coldcall_recordings(call_id,tenant_id,provider_recording_sid,recording_source_url,
   duration_sec,status,queue_status,queue_next_attempt_at)
 VALUES(p_call_id,p_tenant_id,p_provider_sid,p_source_url,p_duration,'processing','pending',now())
 ON CONFLICT(provider_recording_sid) WHERE provider_recording_sid IS NOT NULL
 DO UPDATE SET recording_source_url=COALESCE(coldcall_recordings.recording_source_url,EXCLUDED.recording_source_url),
   duration_sec=GREATEST(COALESCE(coldcall_recordings.duration_sec,0),EXCLUDED.duration_sec)
 RETURNING id INTO v_id;
 RETURN v_id;
END; $$;

CREATE OR REPLACE FUNCTION coldcall_claim_recording_job(p_lease UUID,p_lease_seconds INTEGER DEFAULT 300)
RETURNS SETOF coldcall_recordings LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_id UUID;
BEGIN
 SELECT id INTO v_id FROM coldcall_recordings
 WHERE queue_attempts<8 AND (
   (queue_status IN ('pending','failed') AND COALESCE(queue_next_attempt_at,now())<=now())
   OR (queue_status='leased' AND queue_lease_expires_at<now())
 ) ORDER BY queue_next_attempt_at NULLS FIRST,created_at
 FOR UPDATE SKIP LOCKED LIMIT 1;
 IF v_id IS NULL THEN RETURN; END IF;
 RETURN QUERY UPDATE coldcall_recordings SET queue_status='leased',queue_attempts=queue_attempts+1,
   queue_lease_token=p_lease,
   queue_lease_expires_at=now()+make_interval(secs=>LEAST(GREATEST(p_lease_seconds,30),900)),
   queue_last_error=NULL
 WHERE id=v_id RETURNING *;
END; $$;

CREATE OR REPLACE FUNCTION coldcall_finish_recording_job(
 p_recording_id UUID,p_lease UUID,p_success BOOLEAN,p_error TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 UPDATE coldcall_recordings SET
   queue_status=CASE WHEN p_success THEN 'completed' ELSE 'failed' END,
   queue_completed_at=CASE WHEN p_success THEN now() ELSE NULL END,
   queue_next_attempt_at=CASE WHEN p_success THEN NULL
     ELSE now()+make_interval(secs=>LEAST(1800,15*(2^LEAST(queue_attempts,7))::INTEGER)) END,
   queue_last_error=CASE WHEN p_success THEN NULL ELSE left(COALESCE(p_error,'unknown error'),2000) END,
   queue_lease_token=NULL,queue_lease_expires_at=NULL
 WHERE id=p_recording_id AND queue_status='leased' AND queue_lease_token=p_lease;
 RETURN FOUND;
END; $$;

CREATE OR REPLACE FUNCTION coldcall_renew_recording_job(
 p_recording_id UUID,p_lease UUID,p_lease_seconds INTEGER DEFAULT 300
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 UPDATE coldcall_recordings SET
   queue_lease_expires_at=now()+make_interval(secs=>LEAST(GREATEST(p_lease_seconds,30),900))
 WHERE id=p_recording_id AND queue_status='leased' AND queue_lease_token=p_lease
   AND queue_lease_expires_at>=now();
 RETURN FOUND;
END; $$;

CREATE OR REPLACE FUNCTION coldcall_grant_minutes(
 p_tenant_id UUID,p_minutes NUMERIC,p_kind TEXT,p_reason TEXT,p_created_by UUID,p_source TEXT,
 p_idempotency_key TEXT,p_payload_fingerprint TEXT
) RETURNS NUMERIC LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_existing coldcall_credit_ledger; v_new NUMERIC; v_id UUID;
BEGIN
 PERFORM 1 FROM coldcall_settings WHERE tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'coldcall_settings_missing'; END IF;
 SELECT * INTO v_existing FROM coldcall_credit_ledger
  WHERE tenant_id=p_tenant_id AND idempotency_key=p_idempotency_key;
 IF FOUND THEN
   IF v_existing.payload_fingerprint IS DISTINCT FROM p_payload_fingerprint
     THEN RAISE EXCEPTION 'coldcall_idempotency_payload_mismatch' USING ERRCODE='P0001'; END IF;
   RETURN v_existing.balance_after;
 END IF;
 UPDATE coldcall_settings SET minutes_balance=minutes_balance+p_minutes,updated_at=now()
  WHERE tenant_id=p_tenant_id RETURNING minutes_balance INTO v_new;
 INSERT INTO coldcall_credit_ledger(tenant_id,delta_minutes,kind,balance_after,reason,created_by,source,idempotency_key,payload_fingerprint)
 VALUES(p_tenant_id,p_minutes,p_kind,v_new,p_reason,p_created_by,p_source,p_idempotency_key,p_payload_fingerprint);
 RETURN v_new;
END; $$;

REVOKE EXECUTE ON FUNCTION coldcall_start_call(UUID,UUID,UUID,UUID,UUID,TEXT,TEXT,TEXT,NUMERIC,TEXT,TEXT,TEXT,NUMERIC,BOOLEAN) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION coldcall_finalize_call(UUID,UUID,TEXT,TIMESTAMPTZ,TIMESTAMPTZ,INTEGER,NUMERIC,NUMERIC) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION coldcall_reconcile_usage(INTEGER) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION coldcall_claim_provisioning(UUID,UUID) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION coldcall_finish_provisioning(UUID,UUID,BOOLEAN) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION coldcall_assert_provisioning_claim(UUID,UUID) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION coldcall_persist_provisioning(UUID,UUID,TEXT,TEXT,TEXT,TEXT,TEXT,BOOLEAN) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION coldcall_reserve_number(UUID,TEXT,TEXT,TEXT,NUMERIC,UUID) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION coldcall_complete_number(UUID,UUID,TEXT,TEXT,TEXT) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION coldcall_release_number_reservation(UUID,UUID) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION coldcall_mark_number_cleanup(UUID,UUID,TEXT,TEXT) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION coldcall_claim_explicit_number_release(UUID,UUID) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION coldcall_complete_explicit_number_release(UUID,UUID) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION coldcall_mark_number_ambiguous(UUID,UUID,TEXT) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION coldcall_claim_number_cleanup(UUID,INTEGER) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION coldcall_finish_number_cleanup(UUID,UUID,BOOLEAN,TEXT) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION coldcall_finish_number_reconciliation(UUID,UUID,BOOLEAN,TEXT,TEXT) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION coldcall_enqueue_recording(UUID,UUID,TEXT,TEXT,INTEGER) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION coldcall_claim_recording_job(UUID,INTEGER) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION coldcall_finish_recording_job(UUID,UUID,BOOLEAN,TEXT) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION coldcall_renew_recording_job(UUID,UUID,INTEGER) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION coldcall_grant_minutes(UUID,NUMERIC,TEXT,TEXT,UUID,TEXT,TEXT,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION coldcall_start_call(UUID,UUID,UUID,UUID,UUID,TEXT,TEXT,TEXT,NUMERIC,TEXT,TEXT,TEXT,NUMERIC,BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION coldcall_finalize_call(UUID,UUID,TEXT,TIMESTAMPTZ,TIMESTAMPTZ,INTEGER,NUMERIC,NUMERIC) TO service_role;
GRANT EXECUTE ON FUNCTION coldcall_reconcile_usage(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION coldcall_claim_provisioning(UUID,UUID) TO service_role;
GRANT EXECUTE ON FUNCTION coldcall_finish_provisioning(UUID,UUID,BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION coldcall_assert_provisioning_claim(UUID,UUID) TO service_role;
GRANT EXECUTE ON FUNCTION coldcall_persist_provisioning(UUID,UUID,TEXT,TEXT,TEXT,TEXT,TEXT,BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION coldcall_reserve_number(UUID,TEXT,TEXT,TEXT,NUMERIC,UUID) TO service_role;
GRANT EXECUTE ON FUNCTION coldcall_complete_number(UUID,UUID,TEXT,TEXT,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION coldcall_release_number_reservation(UUID,UUID) TO service_role;
GRANT EXECUTE ON FUNCTION coldcall_mark_number_cleanup(UUID,UUID,TEXT,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION coldcall_claim_explicit_number_release(UUID,UUID) TO service_role;
GRANT EXECUTE ON FUNCTION coldcall_complete_explicit_number_release(UUID,UUID) TO service_role;
GRANT EXECUTE ON FUNCTION coldcall_mark_number_ambiguous(UUID,UUID,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION coldcall_claim_number_cleanup(UUID,INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION coldcall_finish_number_cleanup(UUID,UUID,BOOLEAN,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION coldcall_finish_number_reconciliation(UUID,UUID,BOOLEAN,TEXT,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION coldcall_enqueue_recording(UUID,UUID,TEXT,TEXT,INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION coldcall_claim_recording_job(UUID,INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION coldcall_finish_recording_job(UUID,UUID,BOOLEAN,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION coldcall_renew_recording_job(UUID,UUID,INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION coldcall_grant_minutes(UUID,NUMERIC,TEXT,TEXT,UUID,TEXT,TEXT,TEXT) TO service_role;
