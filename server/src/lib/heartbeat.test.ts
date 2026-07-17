import { describe, it, expect } from 'vitest';
import { recordTick, getHeartbeats, getHeartbeatsPublic } from './heartbeat';

describe('heartbeat registry', () => {
    it('records a successful tick: lastOkAt set, no error', () => {
        recordTick('jobA', true);
        const b = getHeartbeats()['jobA'];
        expect(b.lastError).toBeNull();
        expect(b.lastOkAt).toBe(b.lastTickAt);
        expect(typeof b.lastTickAt).toBe('string');
    });

    it('records a failure but preserves the last success time', () => {
        recordTick('jobB', true);
        const okAt = getHeartbeats()['jobB'].lastOkAt;
        recordTick('jobB', false, new Error('boom'));
        const b = getHeartbeats()['jobB'];
        expect(b.lastError).toBe('boom');
        expect(b.lastOkAt).toBe(okAt); // carried over from the last success
    });

    it('clears the error on the next success', () => {
        recordTick('jobC', false, new Error('x'));
        recordTick('jobC', true);
        expect(getHeartbeats()['jobC'].lastError).toBeNull();
    });

    it('stringifies non-Error failures and defaults to "unknown"', () => {
        recordTick('jobD', false, 'plain string');
        expect(getHeartbeats()['jobD'].lastError).toBe('plain string');
        recordTick('jobE', false);
        expect(getHeartbeats()['jobE'].lastError).toBe('unknown');
    });

    it('getHeartbeatsPublic exposes ok boolean but never the raw lastError text', () => {
        recordTick('pubOk', true);
        recordTick('pubFail', false, new Error('secret-db-host:5432 relation "x"'));
        const pub = getHeartbeatsPublic();
        expect(pub['pubOk'].ok).toBe(true);
        expect(pub['pubFail'].ok).toBe(false);
        expect((pub['pubFail'] as Record<string, unknown>).lastError).toBeUndefined();
        expect(JSON.stringify(pub)).not.toContain('secret-db-host');
    });
});
