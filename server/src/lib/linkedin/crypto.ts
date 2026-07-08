/**
 * LinkedIn cookie encryption — AES-256-GCM.
 *
 * Blob format: base64( iv[12] || tag[16] || ciphertext ), keyed by
 * LINKEDIN_COOKIE_ENC_KEY (64 hex = 32 bytes) — a SEPARATE key domain from the
 * CRM's ENCRYPTION_KEY (SMTP/IMAP), so a LinkedIn key rotation never touches
 * email secrets.
 *
 * Fail-closed, HARD: missing/malformed key -> AppError(500). No dev-fallback key —
 * these cookies carry account-takeover + PII weight, so there is never a silent
 * plaintext path. Plaintext is NEVER stored or logged — only the encrypted blob.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { AppError } from '../../middleware/errorHandler.js';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;   // GCM standard nonce
const TAG_LEN = 16;  // GCM auth tag

function getKey(): Buffer {
    const hex = process.env.LINKEDIN_COOKIE_ENC_KEY;
    if (!hex) throw new AppError('LINKEDIN_COOKIE_ENC_KEY not configured', 500);
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
        throw new AppError('LINKEDIN_COOKIE_ENC_KEY must be 64 hex characters (32 bytes)', 500);
    }
    return Buffer.from(hex, 'hex');
}

export function isLinkedInEncryptionConfigured(): boolean {
    return !!process.env.LINKEDIN_COOKIE_ENC_KEY;
}

/** Encrypt a UTF-8 cookie value. Returns base64(iv || tag || ciphertext). */
export function encryptCookie(plain: string): string {
    const key = getKey();
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGO, key, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ct]).toString('base64');
}

/** Decrypt a base64(iv || tag || ciphertext) blob back to the original string. */
export function decryptCookie(blob: string): string {
    const key = getKey();
    const buf = Buffer.from(blob, 'base64');
    if (buf.length < IV_LEN + TAG_LEN) throw new AppError('Encrypted cookie blob is malformed', 500);
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ct = buf.subarray(IV_LEN + TAG_LEN);
    const d = createDecipheriv(ALGO, key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}
