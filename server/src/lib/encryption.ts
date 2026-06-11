/**
 * Symmetric encryption for at-rest secrets (SMTP/IMAP passwords).
 *
 * AES-256-GCM. The blob format is base64( iv[12] || authTag[16] || ciphertext ).
 * The key comes from ENCRYPTION_KEY (64 hex chars = 32 bytes).
 *
 * Plaintext passwords are NEVER stored or logged — only the encrypted blob.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { createLogger } from './logger.js';
import { AppError } from '../middleware/errorHandler.js';

const log = createLogger('encryption');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;   // GCM standard nonce length
const TAG_LEN = 16;  // GCM auth tag length

// Dev-only fallback key. Available ONLY with an explicit opt-in (see below) so it
// can never be used silently on a deployed environment. NEVER used with real data.
const DEV_FALLBACK_KEY = '0'.repeat(64);

let _warned = false;

function getKey(): Buffer {
    const hex = process.env.ENCRYPTION_KEY;

    if (!hex) {
        // Fail closed everywhere by default. Previously this fell back to a public
        // all-zero key unless NODE_ENV === 'production' — which silently provided
        // NO confidentiality on any environment (e.g. staging) where NODE_ENV was
        // not exactly 'production'. The insecure fallback now requires an explicit
        // opt-in that no deployed environment should ever set.
        if (process.env.ALLOW_INSECURE_ENCRYPTION_KEY !== 'true') {
            throw new AppError('ENCRYPTION_KEY not configured', 500);
        }
        if (!_warned) {
            log.warn('ENCRYPTION_KEY not set — using INSECURE all-zero dev fallback key (ALLOW_INSECURE_ENCRYPTION_KEY=true). Never use this with real data.');
            _warned = true;
        }
        return Buffer.from(DEV_FALLBACK_KEY, 'hex');
    }

    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
        throw new AppError('ENCRYPTION_KEY must be 64 hex characters (32 bytes)', 500);
    }
    return Buffer.from(hex, 'hex');
}

export function isEncryptionConfigured(): boolean {
    return !!process.env.ENCRYPTION_KEY;
}

/** Encrypt a UTF-8 string. Returns base64(iv || tag || ciphertext). */
export function encrypt(plain: string): string {
    const key = getKey();
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGO, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/** Decrypt a base64(iv || tag || ciphertext) blob back to the original string. */
export function decrypt(blob: string): string {
    const key = getKey();
    const buf = Buffer.from(blob, 'base64');
    if (buf.length < IV_LEN + TAG_LEN) {
        throw new AppError('Encrypted blob is malformed', 500);
    }
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
