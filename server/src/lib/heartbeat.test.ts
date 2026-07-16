import { describe, it, expect } from 'vitest';
import { recordTick, getHeartbeats } from './heartbeat';

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
});
