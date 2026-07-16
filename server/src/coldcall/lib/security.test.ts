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
    assert.match(source, /coldcall_claim_recording/);
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
