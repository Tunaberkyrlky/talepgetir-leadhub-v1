import { describe, it, expect } from 'vitest';
import { encrypt, decrypt } from './encryption';

// ENCRYPTION_KEY is provided as a 64-hex test key via vitest.config.ts env.
describe('encryption (AES-256-GCM)', () => {
    it('round-trips: decrypt(encrypt(x)) === x and the blob hides the plaintext', () => {
        const plain = 'super-secret-imap-password';
        const blob = encrypt(plain);
        expect(blob).not.toContain(plain);
        expect(decrypt(blob)).toBe(plain);
    });

    it('uses a random IV: same plaintext encrypts to different blobs', () => {
        expect(encrypt('same')).not.toBe(encrypt('same'));
    });

    it('rejects a tampered blob (GCM auth tag mismatch)', () => {
        const blob = encrypt('x');
        const bytes = Buffer.from(blob, 'base64');
        bytes[bytes.length - 1] ^= 0xff; // flip last ciphertext byte
        expect(() => decrypt(bytes.toString('base64'))).toThrow();
    });
});
