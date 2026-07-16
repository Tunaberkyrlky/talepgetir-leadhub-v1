import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { countryForE164 } from '../data/countryPricing.js';
import { signNumberOffer, verifyNumberOffer } from './numberOffers.js';

const tenant = '11111111-1111-4111-8111-111111111111';
const otherTenant = '22222222-2222-4222-8222-222222222222';

test('number offer rejects tampering, expiry, and cross-tenant replay', () => {
    process.env.COLDCALL_OFFER_SECRET = 'test-only-secret-at-least-thirty-two-characters';
    const token = signNumberOffer({
        tenantId: tenant, provider: 'mock', e164: '+12025550123', country: 'US',
        numberType: 'local', monthlyCogsUsd: 1.15, expiresAt: Date.now() + 60_000,
    });
    assert.equal(verifyNumberOffer(token, tenant).e164, '+12025550123');
    const [payload, signature] = token.split('.');
    const tampered = `${payload}.${signature[0] === 'a' ? 'b' : 'a'}${signature.slice(1)}`;
    assert.throws(() => verifyNumberOffer(tampered, tenant));
    assert.throws(() => verifyNumberOffer(token, otherTenant));
    const expired = signNumberOffer({
        tenantId: tenant, provider: 'mock', e164: '+12025550123', country: 'US',
        numberType: 'local', monthlyCogsUsd: 1.15, expiresAt: Date.now() - 1,
    });
    assert.throws(() => verifyNumberOffer(expired, tenant));
});

test('unknown NANPA area codes fail closed', () => {
    assert.equal(countryForE164('+12025550123')?.code, 'US');
    assert.equal(countryForE164('+14165550123')?.code, 'CA');
    assert.equal(countryForE164('+19995550123'), undefined);
});

test('forward migration encodes atomic and idempotent database contracts', () => {
    const sql = readFileSync(
        join(process.cwd(), 'supabase/migrations/20260716213000_coldcall_atomicity_hardening.sql'),
        'utf8',
    );
    assert.match(sql, /coldcall_start_call[\s\S]*FOR UPDATE[\s\S]*coldcall_balance_exhausted/);
    assert.match(sql, /coldcall_finalize_call[\s\S]*WHERE id=p_call_id AND tenant_id=p_tenant_id FOR UPDATE/);
    assert.match(sql, /-v_call\.billed_minutes/);
    assert.match(sql, /UNIQUE INDEX[\s\S]*provider_recording_sid/);
    assert.match(sql, /ON coldcall_credit_ledger\(tenant_id, idempotency_key\)/);
    assert.match(sql, /coldcall_idempotency_payload_mismatch/);
    assert.match(sql, /coldcall_reserve_number[\s\S]*FOR UPDATE[\s\S]*coldcall_number_quota/);
    assert.doesNotMatch(sql, /30 days/);
});

test('status webhook only acknowledges after successful processing and retries failures', () => {
    const source = readFileSync(join(process.cwd(), 'server/src/coldcall/routes/webhooks.ts'), 'utf8');
    const statusHandler = source.slice(source.indexOf("router.post('/status'"), source.indexOf("router.post('/recording'"));
    assert.ok(statusHandler.indexOf('await finalizeCall') < statusHandler.lastIndexOf('res.status(204).end()'));
    assert.match(statusHandler, /catch \(err\)[\s\S]*res\.status\(503\)/);
    assert.match(source, /coldcall_enqueue_recording/);
    const recordingHandler = source.slice(source.indexOf("router.post('/recording'"));
    assert.ok(recordingHandler.indexOf('coldcall_enqueue_recording') < recordingHandler.lastIndexOf('res.status(204).end()'));
    assert.doesNotMatch(recordingHandler, /runTwilioRecordingPipeline/);
});

test('admin provisioning is superadmin-only and durable-claim guarded', () => {
    const source = readFileSync(join(process.cwd(), 'server/src/coldcall/routes/admin.ts'), 'utf8');
    const provision = source.slice(source.indexOf("router.post('/provision'"), source.indexOf('// ── POST /credits/grant'));
    assert.match(provision, /requireRole\('superadmin'\)/);
    assert.match(provision, /coldcall_claim_provisioning/);
    assert.match(provision, /coldcall_finish_provisioning/);
});

test('migration filenames and active-call preservation are stable', () => {
    const base = readFileSync(join(process.cwd(), 'supabase/migrations/20260714173500_coldcall_credit_wallet.sql'), 'utf8');
    assert.match(base, /row_number\(\) OVER \(PARTITION BY tenant_id ORDER BY created_at DESC, id DESC\)/);
    assert.match(base, /active_rank > 1/);
    assert.throws(() => readFileSync(join(process.cwd(), 'supabase/migrations/146_coldcall_credit_wallet.sql')));
});

test('recording queue is idempotent, fenced, reclaimable, and scheduler-driven', () => {
    const sql = readFileSync(
        join(process.cwd(), 'supabase/migrations/20260716213000_coldcall_atomicity_hardening.sql'),
        'utf8',
    );
    assert.match(sql, /coldcall_enqueue_recording[\s\S]*ON CONFLICT\(provider_recording_sid\)[\s\S]*DO UPDATE/);
    assert.match(sql, /coldcall_claim_recording_job[\s\S]*queue_status='leased'[\s\S]*queue_lease_expires_at<now\(\)[\s\S]*FOR UPDATE SKIP LOCKED/);
    assert.match(sql, /coldcall_finish_recording_job[\s\S]*queue_lease_token=p_lease/);
    assert.match(sql, /coldcall_renew_recording_job[\s\S]*queue_lease_token=p_lease/);
    assert.match(sql, /queue_attempts<8/);

    const routes = readFileSync(join(process.cwd(), 'server/src/coldcall/routes/index.ts'), 'utf8');
    const scheduler = readFileSync(join(process.cwd(), 'server/src/coldcall/lib/recordingScheduler.ts'), 'utf8');
    assert.match(routes, /startColdcallRecordingScheduler\(\)/);
    assert.match(scheduler, /coldcall_claim_recording_job/);
    assert.match(scheduler, /await runTwilioRecordingPipeline/);
    assert.match(scheduler, /coldcall_finish_recording_job/);
});

test('offer signing secret is documented as required and 32+ characters', () => {
    const example = readFileSync(join(process.cwd(), '.env.example'), 'utf8');
    assert.match(example, /at least 32 characters[\s\S]*COLDCALL_OFFER_SECRET=/);
});

test('provisioning persists resources through fenced claim-aware steps', () => {
    const provider = readFileSync(join(process.cwd(), 'server/src/coldcall/providers/twilio.ts'), 'utf8');
    const sql = readFileSync(join(process.cwd(), 'supabase/migrations/20260716213000_coldcall_atomicity_hardening.sql'), 'utf8');
    assert.match(provider, /coldcall_assert_provisioning_claim/);
    assert.match(provider, /coldcall_persist_provisioning/);
    assert.match(provider, /existingApps[\s\S]*friendlyName: 'tgcore-coldcall'/);
    assert.match(provider, /orphanKeys[\s\S]*\.remove\(\)/);
    assert.match(sql, /coldcall_persist_provisioning[\s\S]*provisioning_claim=p_claim/);
});

test('ambiguous number purchases and failed compensation remain durably reconcilable', () => {
    const route = readFileSync(join(process.cwd(), 'server/src/coldcall/routes/numbers.ts'), 'utf8');
    const scheduler = readFileSync(join(process.cwd(), 'server/src/coldcall/lib/numberCleanupScheduler.ts'), 'utf8');
    assert.match(route, /findOwnedNumber/);
    assert.match(route, /coldcall_mark_number_ambiguous/);
    assert.match(route, /coldcall_mark_number_cleanup/);
    assert.match(scheduler, /coldcall_claim_number_cleanup/);
    assert.match(scheduler, /FOR UPDATE|finish_number/);
});

test('voice and mock async paths forward or catch failures', () => {
    const webhook = readFileSync(join(process.cwd(), 'server/src/coldcall/routes/webhooks.ts'), 'utf8');
    const mock = readFileSync(join(process.cwd(), 'server/src/coldcall/providers/mock.ts'), 'utf8');
    assert.match(webhook, /handleVoice\(req, res\)\.catch\(next\)/);
    assert.match(mock, /task\(\)\.catch/);
    assert.doesNotMatch(mock, /setTimeout\(async/);
});

test('recording pipeline keeps provider media until durable storage and fences expensive work', () => {
    const pipeline = readFileSync(join(process.cwd(), 'server/src/coldcall/lib/pipeline.ts'), 'utf8');
    const scheduler = readFileSync(join(process.cwd(), 'server/src/coldcall/lib/recordingScheduler.ts'), 'utf8');
    assert.match(pipeline, /recording row insert failed:[\s\S]*throw new Error/);
    assert.ok(pipeline.indexOf('await storeRecording') < pipeline.indexOf("method: 'DELETE'"));
    assert.match(pipeline, /existing\.status === 'stored'[\s\S]*storage\.from\(BUCKET\)\.download/);
    assert.ok(pipeline.indexOf('await writeTranscriptAndSummary') < pipeline.indexOf("method: 'DELETE'"));
    assert.ok(pipeline.indexOf('await summarizeAndPersist') < pipeline.indexOf("method: 'DELETE'"));
    assert.match(pipeline, /deepgram transcription failed'[\s\S]*throw err/);
    assert.match(pipeline, /terminalFailure: 'unavailable'/);
    assert.match(pipeline, /await assertLease\?\.\(\)[\s\S]*deepgramTranscribe/);
    assert.match(scheduler, /recording lease lost/);
    assert.match(scheduler, /job\.id,[\s\S]*assertLease/);
});

test('ambiguous purchase requires delayed repeated ownership checks', () => {
    const route = readFileSync(join(process.cwd(), 'server/src/coldcall/routes/numbers.ts'), 'utf8');
    const scheduler = readFileSync(join(process.cwd(), 'server/src/coldcall/lib/numberCleanupScheduler.ts'), 'utf8');
    assert.match(route, /catch \(purchaseError\)[\s\S]*coldcall_mark_number_ambiguous/);
    assert.doesNotMatch(route.slice(route.indexOf('catch (purchaseError)'), route.indexOf('const { data, error }')), /coldcall_release_number_reservation/);
    assert.match(scheduler, /cleanup_attempts < 3/);
    assert.match(scheduler, /delayed confirmation required/);
});

test('explicit number deletion cannot bypass durable reconciliation states', () => {
    const route = readFileSync(join(process.cwd(), 'server/src/coldcall/routes/numbers.ts'), 'utf8');
    const deletion = route.slice(route.indexOf("router.delete('/:id'"));
    assert.match(deletion, /\['active', 'pending_regulatory'\]\.includes\(num\.status\)/);
    assert.match(deletion, /coldcall_claim_explicit_number_release/);
    assert.match(deletion, /await providerFor\(scopedSettings\)\.releaseNumber\(scopedSettings/);
    assert.match(deletion, /coldcall_complete_explicit_number_release/);
    assert.doesNotMatch(deletion, /\.update\(\{ status: 'released'/);
});

test('all released-number transitions clear the tenant default transactionally', () => {
    const sql = readFileSync(join(process.cwd(), 'supabase/migrations/20260716213000_coldcall_atomicity_hardening.sql'), 'utf8');
    for (const functionName of [
        'coldcall_complete_explicit_number_release',
        'coldcall_finish_number_cleanup',
        'coldcall_finish_number_reconciliation',
    ]) {
        const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${functionName}`);
        const body = sql.slice(start, sql.indexOf('END; $$;', start));
        assert.match(body, /UPDATE coldcall_settings SET default_phone_number_id=NULL/);
        assert.match(body, /default_phone_number_id=p_number_id/);
    }
    const route = readFileSync(join(process.cwd(), 'server/src/coldcall/routes/numbers.ts'), 'utf8');
    const deletion = route.slice(route.indexOf("router.delete('/:id'"));
    assert.doesNotMatch(deletion, /default_phone_number_id/);
});

test('persisted provider selection fails closed and number operations bind recorded provider', () => {
    const factory = readFileSync(join(process.cwd(), 'server/src/coldcall/providers/index.ts'), 'utf8');
    const route = readFileSync(join(process.cwd(), 'server/src/coldcall/routes/numbers.ts'), 'utf8');
    const cleanup = readFileSync(join(process.cwd(), 'server/src/coldcall/lib/numberCleanupScheduler.ts'), 'utf8');
    assert.match(factory, /settings\.provider === 'mock'[\s\S]*return mockProvider/);
    assert.match(factory, /settings\.provider === 'twilio'[\s\S]*throw new AppError\('Twilio provider is unavailable/);
    assert.doesNotMatch(factory, /if \(settings\.provider === 'twilio'.*\) return twilioProvider;\s*return mockProvider/s);
    assert.match(route.slice(route.indexOf("router.delete('/:id'")), /provider: num\.provider/);
    assert.match(cleanup, /provider: job\.provider/);
});

test('stale purchasing reservations are conservatively promoted and reconciled', () => {
    const sql = readFileSync(join(process.cwd(), 'supabase/migrations/20260716213000_coldcall_atomicity_hardening.sql'), 'utf8');
    const reserve = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION coldcall_reserve_number'), sql.indexOf('CREATE OR REPLACE FUNCTION coldcall_complete_number'));
    const complete = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION coldcall_complete_number'), sql.indexOf('CREATE OR REPLACE FUNCTION coldcall_release_number_reservation'));
    const claim = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION coldcall_claim_number_cleanup'), sql.indexOf('CREATE OR REPLACE FUNCTION coldcall_finish_number_cleanup'));
    assert.match(reserve, /cleanup_next_attempt_at[\s\S]*interval '15 minutes'/);
    assert.match(complete, /cleanup_next_attempt_at=NULL/);
    assert.match(claim, /status='purchasing'[\s\S]*cleanup_next_attempt_at<=now\(\)[\s\S]*status IN \('release_pending','purchase_unknown'\)/);
    assert.match(sql, /REVOKE EXECUTE ON FUNCTION coldcall_claim_number_cleanup/);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION coldcall_claim_number_cleanup[\s\S]*TO service_role/);
});

test('number release RPCs lock settings before mutating phone rows', () => {
    const sql = readFileSync(join(process.cwd(), 'supabase/migrations/20260716213000_coldcall_atomicity_hardening.sql'), 'utf8');
    for (const functionName of [
        'coldcall_complete_explicit_number_release',
        'coldcall_finish_number_cleanup',
        'coldcall_finish_number_reconciliation',
    ]) {
        const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${functionName}`);
        const body = sql.slice(start, sql.indexOf('END; $$;', start));
        const settingsLock = body.indexOf('FROM coldcall_settings');
        const phoneUpdate = body.indexOf('UPDATE coldcall_phone_numbers');
        assert.ok(settingsLock >= 0 && settingsLock < phoneUpdate, `${functionName} must lock settings first`);
        assert.match(body, /FROM coldcall_settings[\s\S]*FOR UPDATE/);
    }
});

test('recording retries resume durable transcript state without duplicate STT or AI', () => {
    const pipeline = readFileSync(join(process.cwd(), 'server/src/coldcall/lib/pipeline.ts'), 'utf8');
    const resumeCheck = pipeline.indexOf("existingTranscript?.status === 'done'");
    const deepgram = pipeline.indexOf('const stt = await deepgramTranscribe');
    assert.ok(resumeCheck >= 0 && resumeCheck < deepgram);
    assert.match(pipeline, /status === 'pending'[\s\S]*existingTranscript\.segments[\s\S]*summarizeAndPersist/);
    assert.match(pipeline, /status === 'done' \|\| existing\?\.status === 'failed'\) return/);
    assert.match(pipeline, /\.eq\('status', 'pending'\)/);
    assert.doesNotMatch(pipeline, /coldcall_transcripts'\)\.upsert/);
});
