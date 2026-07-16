import { describe, it, expect } from 'vitest';
import { isInternalRole, INTERNAL_ROLES } from './roles';

describe('isInternalRole', () => {
    it('returns true for internal staff roles', () => {
        expect(isInternalRole('superadmin')).toBe(true);
        expect(isInternalRole('ops_agent')).toBe(true);
    });

    it('returns false for client roles', () => {
        expect(isInternalRole('client_admin')).toBe(false);
        expect(isInternalRole('client_viewer')).toBe(false);
    });

    it('is strict: no trimming, case-sensitive, empty is false', () => {
        expect(isInternalRole('')).toBe(false);
        expect(isInternalRole('superadmin ')).toBe(false);
        expect(isInternalRole('SUPERADMIN')).toBe(false);
    });

    it('INTERNAL_ROLES is exactly the two staff roles', () => {
        expect([...INTERNAL_ROLES]).toEqual(['superadmin', 'ops_agent']);
    });
});
