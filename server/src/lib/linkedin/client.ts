/**
 * ServerLinkedInClient — the transport seam (§7). Replays a captured cookie against
 * LinkedIn's Voyager API through the account's STICKY proxy dispatcher (so every call
 * for an account exits from the same IP, §3). Faz 1 implements validateSession; Faz 2
 * adds sendInvite / sendMessage on the same seam.
 *
 * NEVER trust the HTTP status alone (§4.4): a 2xx counts as "alive" ONLY when the body
 * actually parsed as JSON — a 2xx login-wall/redirect stub with a non-JSON body is a
 * dead session masquerading as 200 and is classified 'unknown', not 'success'.
 */
import { request, type Dispatcher } from 'undici';
import { VOYAGER, buildHeaders, parseMeIdentity, type VoyagerCreds, type LinkedInIdentity } from './voyager.js';

const HEADERS_TIMEOUT_MS = 15_000;
const BODY_TIMEOUT_MS = 20_000;
const TOTAL_DEADLINE_MS = 30_000; // hard wall-clock cap (chunk-pacing can defeat bodyTimeout)

export type ValidateClassifier =
    | 'success'
    | 'session_invalid'
    | 'challenge'
    | 'restricted'
    | 'rate_limited'
    | 'unknown';

export interface ValidateResult {
    /** Raw upstream HTTP status (advisory). */
    httpStatus: number;
    classifier: ValidateClassifier;
    /** Parsed identity on success; null otherwise. */
    identity: LinkedInIdentity | null;
    /** True only when the session is confirmed alive (2xx WITH a JSON body). */
    ok: boolean;
}

/**
 * Probe /voyager/api/me through the account's sticky proxy dispatcher.
 * Throws only on TRANSPORT failure (proxy down / timeout / abort) — the caller treats a
 * thrown error as a job failure, and a returned result (any classifier) as a successful
 * check.
 */
export async function validateSession(creds: VoyagerCreds, dispatcher: Dispatcher): Promise<ValidateResult> {
    const url = `${VOYAGER.base}${VOYAGER.mePath}`;
    const res = await request(url, {
        method: 'GET',
        headers: { ...buildHeaders(creds), referer: `${VOYAGER.base}/feed/` },
        dispatcher,
        headersTimeout: HEADERS_TIMEOUT_MS,
        bodyTimeout: BODY_TIMEOUT_MS,
        signal: AbortSignal.timeout(TOTAL_DEADLINE_MS),
    });

    const status = res.statusCode;

    // Always drain the body to free the socket; track whether it was valid JSON.
    let body: unknown = null;
    let jsonOk = false;
    try {
        body = await res.body.json();
        jsonOk = true;
    } catch {
        try { await res.body.text(); } catch { /* ignore */ }
    }

    if (status >= 200 && status < 300) {
        // §4.4: a 2xx WITHOUT a JSON body is a dead/challenged session, not "alive".
        if (!jsonOk) return { httpStatus: status, classifier: 'unknown', identity: null, ok: false };
        let identity: LinkedInIdentity | null = null;
        try { identity = parseMeIdentity(body); } catch { identity = null; }
        return { httpStatus: status, classifier: 'success', identity, ok: true };
    }
    if (status === 401) return { httpStatus: status, classifier: 'session_invalid', identity: null, ok: false };
    if (status === 403) return { httpStatus: status, classifier: 'restricted', identity: null, ok: false };
    if (status === 999) return { httpStatus: status, classifier: 'challenge', identity: null, ok: false };
    if (status === 429) return { httpStatus: status, classifier: 'rate_limited', identity: null, ok: false };
    return { httpStatus: status, classifier: 'unknown', identity: null, ok: false };
}
