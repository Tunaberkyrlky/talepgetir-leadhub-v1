import { describe, it, expect } from 'vitest';
import { sanitizeSearch } from './queryUtils';

// This function is a security boundary: user search text flows into PostgREST
// ILIKE filters. It must strip PostgREST syntax and neutralise ILIKE wildcards.
describe('sanitizeSearch', () => {
    it('strips PostgREST syntax characters (, ) . \\ ,', () => {
        expect(sanitizeSearch('a,b(c)d.e')).toBe('abcde');
        expect(sanitizeSearch('back\\slash')).toBe('backslash');
    });

    it('escapes ILIKE wildcards so they match literally', () => {
        expect(sanitizeSearch('50%')).toBe('50\\%');
        expect(sanitizeSearch('a_b')).toBe('a\\_b');
    });

    it('leaves ordinary text untouched', () => {
        expect(sanitizeSearch('Acme Corp')).toBe('Acme Corp');
    });

    it('handles combined injection-ish input', () => {
        expect(sanitizeSearch('%(or)_,.')).toBe('\\%or\\_');
    });
});
