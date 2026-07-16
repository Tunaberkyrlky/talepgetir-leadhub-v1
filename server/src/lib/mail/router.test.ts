import { describe, it, expect } from 'vitest';
import { resolveProvider } from './router';
import { resendProvider } from './resendAdapter';
import { smtpProvider } from './smtpAdapter';
import { nangoProvider } from './nangoAdapter';
import { plusvibeProvider } from './plusvibeAdapter';
import type { CanonicalSendRequest } from './types';

// Only the DB-free routing branches are covered here (accountEmail undefined, so
// no email_connections lookup). This is the outbound-routing matrix: a regression
// here silently sends mail through the wrong provider.
const req = (over: Partial<CanonicalSendRequest>): CanonicalSendRequest =>
    ({ channel: 'compose', tenantId: 't1', ...over }) as CanonicalSendRequest;

describe('resolveProvider — routing matrix (DB-free branches)', () => {
    it('system channel → Resend', async () => {
        expect(await resolveProvider(req({ channel: 'system' }))).toBe(resendProvider);
    });

    it('thread origin decides reply/forward provider', async () => {
        expect(await resolveProvider(req({ channel: 'reply', originProvider: 'smtp' }))).toBe(smtpProvider);
        expect(await resolveProvider(req({ channel: 'reply', originProvider: 'gmail' }))).toBe(nangoProvider);
        expect(await resolveProvider(req({ channel: 'forward', originProvider: 'outlook' }))).toBe(nangoProvider);
        expect(await resolveProvider(req({ channel: 'reply', originProvider: 'plusvibe' }))).toBe(plusvibeProvider);
    });

    it('campaign/compose without account → Nango default', async () => {
        expect(await resolveProvider(req({ channel: 'campaign' }))).toBe(nangoProvider);
        expect(await resolveProvider(req({ channel: 'compose' }))).toBe(nangoProvider);
    });

    it('reply with no origin and no account → PlusVibe fallback', async () => {
        expect(await resolveProvider(req({ channel: 'reply' }))).toBe(plusvibeProvider);
    });
});
