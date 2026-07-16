import { describe, it, expect } from 'vitest';
import { loginSchema, createContactSchema, sanitizeEmail, uuidField } from './validation';

const UUID = '00112233-4455-6677-8899-aabbccddeeff';

describe('loginSchema', () => {
    it('accepts a valid email + password', () => {
        expect(loginSchema.safeParse({ email: 'a@b.com', password: 'secret' }).success).toBe(true);
    });
    it('rejects an invalid email or empty password', () => {
        expect(loginSchema.safeParse({ email: 'nope', password: 'x' }).success).toBe(false);
        expect(loginSchema.safeParse({ email: 'a@b.com', password: '' }).success).toBe(false);
    });
});

describe('sanitizeEmail', () => {
    it('returns the trimmed email for real values', () => {
        expect(sanitizeEmail('  a@b.com ')).toBe('a@b.com');
    });
    it('coerces junk placeholders and non-strings to null', () => {
        expect(sanitizeEmail('N/A')).toBeNull();
        expect(sanitizeEmail('yok')).toBeNull();
        expect(sanitizeEmail('---')).toBeNull();
        expect(sanitizeEmail('')).toBeNull();
        expect(sanitizeEmail(null)).toBeNull();
        expect(sanitizeEmail(42)).toBeNull();
    });
});

describe('createContactSchema', () => {
    it('requires a uuid company_id and a first_name', () => {
        expect(createContactSchema.safeParse({ first_name: 'Ada' }).success).toBe(false);
        expect(createContactSchema.safeParse({ company_id: UUID, first_name: 'Ada' }).success).toBe(true);
    });
    it('coerces a junk email to null via emailField', () => {
        const r = createContactSchema.safeParse({ company_id: UUID, first_name: 'Ada', email: 'n/a' });
        expect(r.success).toBe(true);
        if (r.success) expect(r.data.email).toBeNull();
    });
});

describe('uuidField', () => {
    it('accepts 8-4-4-4-12 hex and rejects anything else', () => {
        expect(uuidField().safeParse(UUID).success).toBe(true);
        expect(uuidField().safeParse('not-a-uuid').success).toBe(false);
    });
});
