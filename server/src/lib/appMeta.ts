import fs from 'fs';
import path from 'path';

// App version — read once at startup. Works in dev (tsx: __dirname=server/src/lib)
// and prod (tsc: __dirname=server/dist/lib); package.json sits two levels up in both.
// Surfaced at /api/health and /api/ops/health so "is the new code actually live?"
// is answerable.
let version = 'unknown';
try {
    version = JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')
    ).version || 'unknown';
} catch { /* leave 'unknown' */ }

export const APP_VERSION = version;
export const STARTED_AT = new Date().toISOString();
