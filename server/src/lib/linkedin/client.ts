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
import {
    VOYAGER, buildHeaders, parseMeIdentity, buildInvitePayload, buildMessagePayload,
    parseProfileUrnFromHtml, parseSentInvitations,
    type VoyagerCreds, type LinkedInIdentity, type MessageParams, type SentInvitation,
} from './voyager.js';

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

// ── WRITE actions (Faz 2): invite + message on the same sticky-proxy seam ─────────

/**
 * Normalized outcome of a write (invite/message). NEVER derived from HTTP status alone
 * (§4.4): LinkedIn 200-wraps failed writes, so `sent` is true ONLY when the status is 2xx
 * AND the body carries no embedded error/limit/duplicate marker.
 */
export type WriteClassifier =
    | 'sent'
    | 'already_connected'   // invite: already 1st-degree / connected
    | 'cant_resend_yet'     // invite: pending/duplicate, cooldown not elapsed
    | 'rate_limited'        // 429 or embedded quota/limit
    | 'restricted'          // 403 / embedded restrict — account restriction, not a bad note
    | 'challenge'           // 999 / checkpoint
    | 'session_invalid'     // 401 — cookie dead
    | 'invalid_request'     // bare 400 with no recognizable embedded marker
    | 'unknown';

export interface WriteResult {
    httpStatus: number;
    classifier: WriteClassifier;
    /** True only when the action definitively landed on LinkedIn. */
    sent: boolean;
    /** Short upstream marker for the audit trail (embedded code / exceptionClass). */
    detail?: string;
}

/**
 * Whether the caller should REFUND the reserved daily-quota slot: true for every outcome
 * that did NOT cleanly land, EXCEPT the two where LinkedIn's own state already reflects the
 * action (already_connected / cant_resend_yet — refunding those would let us re-attempt into
 * a duplicate). `unknown` IS refunded (codex P2): a non-JSON 2xx login-wall / an unrecognized
 * error envelope is a non-send, so keeping the slot would leak quota on dead-session noise.
 * The rare "5xx after LinkedIn actually processed it" over-refunds by one — acceptable: the
 * daily cap is a conservative backstop (not billing), maxAttempts=1 means no auto-retry, and
 * a deliberate operator re-run is independent of this counter.
 */
export function isNotSent(c: WriteClassifier): boolean {
    return c !== 'sent' && c !== 'already_connected' && c !== 'cant_resend_yet';
}

/**
 * Extract LinkedIn's error ENVELOPE from a parsed body, if present. An envelope is the
 * structured failure LinkedIn returns (or 200-wraps) — NEVER the echoed success payload
 * (a createMessage 2xx echoes the message text back, so scanning the whole body for words
 * like "limit"/"challenge" would false-positive on user content, codex P1). We only treat
 * a body as an error when it carries a numeric status>=400, an exceptionClass, or a
 * non-empty errors[] — and we scan ONLY code/message/exceptionClass, not arbitrary text.
 */
function errorEnvelopeText(parsed: unknown): string | null {
    if (!parsed || typeof parsed !== 'object') return null;
    const o = parsed as Record<string, unknown>;
    const statusNum = typeof o.status === 'number' ? o.status : NaN;
    const hasErrors = Array.isArray(o.errors) ? o.errors.length > 0
        : (o.errors != null && typeof o.errors === 'object' && Object.keys(o.errors as object).length > 0);
    const hasException = typeof o.exceptionClass === 'string' && o.exceptionClass.length > 0;
    const isError = (Number.isFinite(statusNum) && statusNum >= 400) || hasErrors || hasException;
    if (!isError) return null;
    // Only the recognized indicator fields feed the marker scan.
    const parts = [o.code, o.message, o.exceptionClass, o.errorDetails]
        .filter((x) => typeof x === 'string') as string[];
    if (hasErrors) parts.push(JSON.stringify(o.errors));
    return parts.join(' ').toLowerCase() || 'error';
}

/** Map an error-envelope marker string to a classifier (order: most specific first). */
function classifyMarker(marker: string): { classifier: WriteClassifier; detail: string } {
    if (marker.includes('cant_resend_yet') || marker.includes('cantresendyet')) return { classifier: 'cant_resend_yet', detail: 'CANT_RESEND_YET' };
    if (marker.includes('already_connected') || marker.includes('alreadyconnected') || marker.includes('already invited')) return { classifier: 'already_connected', detail: 'ALREADY_CONNECTED' };
    if (marker.includes('quota') || marker.includes('limit') || marker.includes('throttl')) return { classifier: 'rate_limited', detail: 'QUOTA_OR_LIMIT' };
    if (marker.includes('restrict') || marker.includes('bounced')) return { classifier: 'restricted', detail: 'RESTRICT' };
    if (marker.includes('challenge') || marker.includes('checkpoint')) return { classifier: 'challenge', detail: 'CHALLENGE' };
    return { classifier: 'unknown', detail: 'EMBEDDED_ERROR' };
}

/** Map a raw HTTP status + JSON-parsed body to a write classifier (§4.4, never status alone). */
function classifyWriteResponse(status: number, rawBody: string): WriteResult {
    // Status-first for the unambiguous transport/auth codes.
    if (status === 401) return { httpStatus: status, classifier: 'session_invalid', sent: false };
    if (status === 403) return { httpStatus: status, classifier: 'restricted', sent: false };
    if (status === 999) return { httpStatus: status, classifier: 'challenge', sent: false };
    if (status === 429) return { httpStatus: status, classifier: 'rate_limited', sent: false };

    let parsed: unknown = null;
    try { parsed = JSON.parse(rawBody); } catch { parsed = null; }
    const marker = errorEnvelopeText(parsed);

    if (status >= 200 && status < 300) {
        // §4.4: a 2xx is "sent" ONLY when the body is valid JSON with NO error envelope.
        // A non-JSON 2xx (login-wall/redirect stub) is NOT a confirmed send.
        if (parsed == null) return { httpStatus: status, classifier: 'unknown', sent: false, detail: 'NON_JSON_2XX' };
        if (marker) { const m = classifyMarker(marker); return { httpStatus: status, classifier: m.classifier, sent: false, detail: m.detail }; }
        return { httpStatus: status, classifier: 'sent', sent: true };
    }
    // 4xx/5xx: prefer the parsed envelope marker; a bare 4xx is an invalid request.
    if (marker) { const m = classifyMarker(marker); return { httpStatus: status, classifier: m.classifier, sent: false, detail: m.detail }; }
    if (status === 400 || status === 409 || status === 422) return { httpStatus: status, classifier: 'invalid_request', sent: false };
    return { httpStatus: status, classifier: 'unknown', sent: false };
}

/** Drain a response body to a string (freeing the socket) without assuming JSON. */
async function drainText(res: Awaited<ReturnType<typeof request>>): Promise<string> {
    try { return await res.body.text(); } catch { return ''; }
}

/** POST a JSON write to Voyager through the account's sticky dispatcher, classified. */
async function postWrite(
    path: string, payload: Record<string, unknown>, creds: VoyagerCreds, dispatcher: Dispatcher,
): Promise<WriteResult> {
    const res = await request(`${VOYAGER.base}${path}`, {
        method: 'POST',
        headers: {
            ...buildHeaders(creds),
            'content-type': 'application/json; charset=UTF-8',
            referer: `${VOYAGER.base}/feed/`,
            origin: VOYAGER.base,
        },
        // JSON.stringify keeps trackingId's 16 code points intact (see randomTrackingId).
        body: JSON.stringify(payload),
        dispatcher,
        headersTimeout: HEADERS_TIMEOUT_MS,
        bodyTimeout: BODY_TIMEOUT_MS,
        signal: AbortSignal.timeout(TOTAL_DEADLINE_MS),
    });
    const raw = await drainText(res);
    return classifyWriteResponse(res.statusCode, raw);
}

/** Send a connection request (noteless by default). Throws only on TRANSPORT failure. */
export function sendInvite(
    creds: VoyagerCreds, dispatcher: Dispatcher, profileUrn: string, note?: string,
): Promise<WriteResult> {
    return postWrite(VOYAGER.invitePath, buildInvitePayload(profileUrn, note), creds, dispatcher);
}

/** Send a NEW-conversation message. Throws only on TRANSPORT failure. */
export function sendMessage(
    creds: VoyagerCreds, dispatcher: Dispatcher, params: MessageParams,
): Promise<WriteResult> {
    return postWrite(VOYAGER.messagePath, buildMessagePayload(params), creds, dispatcher);
}

export interface ResolveResult {
    /** The owner urn on a clean 2xx + scoped match; null on non-2xx or parse miss. */
    urn: string | null;
    /** Upstream HTTP status — lets the caller apply 401/403/999 health transitions (§4.4). */
    httpStatus: number;
}

/**
 * Resolve a fsd_profile urn from a vanity/public id by fetching the public profile HTML
 * through the account's sticky proxy (§4.3). Returns {urn:null} on any non-2xx / parse miss;
 * the httpStatus is surfaced so the caller can distinguish a plain miss from a 401/403/999
 * health signal (codex P2) instead of silently leaving the account ACTIVE. Throws only if
 * the request itself fails (proxy/timeout).
 */
export async function resolveProfileUrn(
    creds: VoyagerCreds, dispatcher: Dispatcher, publicId: string,
): Promise<ResolveResult> {
    const res = await request(`${VOYAGER.base}${VOYAGER.profileHtmlPath(publicId)}`, {
        method: 'GET',
        headers: {
            cookie: buildHeaders(creds).cookie,
            'user-agent': buildHeaders(creds)['user-agent'],
            'accept-language': VOYAGER.acceptLanguage,
            accept: 'text/html,application/xhtml+xml',
            referer: `${VOYAGER.base}/feed/`,
        },
        dispatcher,
        headersTimeout: HEADERS_TIMEOUT_MS,
        bodyTimeout: BODY_TIMEOUT_MS,
        signal: AbortSignal.timeout(TOTAL_DEADLINE_MS),
    });
    const html = await drainText(res);
    if (res.statusCode < 200 || res.statusCode >= 300) return { urn: null, httpStatus: res.statusCode };
    return { urn: parseProfileUrnFromHtml(html), httpStatus: res.statusCode };
}

// ── Pending-invite withdrawal (Faz 3, §2) — same sticky-proxy seam ────────────────

export interface SentInvitationsResult {
    invitations: SentInvitation[];
    httpStatus: number;
    /** True ONLY on a 2xx WITH a JSON body — a confirmed, trustworthy list read. A non-2xx OR
     *  a 2xx non-JSON login-wall/redirect stub is `false`, so the caller must NOT read an empty
     *  `invitations` as "nothing pending" (§4.4: never trust status alone). */
    ok: boolean;
}

/**
 * List the account's OUTGOING pending invitations through its sticky proxy. Returns the parsed
 * list with ok=true only on a clean 2xx+JSON. A non-2xx OR a 2xx whose body is NOT JSON (a
 * login-wall/checkpoint stub, §4.4) returns ok=false + [] so the caller treats it as a failed/
 * unhealthy read — NOT a genuinely empty pending list. Throws only on TRANSPORT failure.
 */
export async function listSentInvitations(
    creds: VoyagerCreds, dispatcher: Dispatcher,
): Promise<SentInvitationsResult> {
    const res = await request(`${VOYAGER.base}${VOYAGER.sentInvitationsPath()}`, {
        method: 'GET',
        headers: { ...buildHeaders(creds), referer: `${VOYAGER.base}/mynetwork/invitation-manager/sent/` },
        dispatcher,
        headersTimeout: HEADERS_TIMEOUT_MS,
        bodyTimeout: BODY_TIMEOUT_MS,
        signal: AbortSignal.timeout(TOTAL_DEADLINE_MS),
    });
    const raw = await drainText(res);
    if (res.statusCode < 200 || res.statusCode >= 300) return { invitations: [], httpStatus: res.statusCode, ok: false };
    let parsed: unknown = null;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    // A 2xx that isn't JSON is a dead/challenged session masquerading as 200 — not an empty list.
    if (parsed == null) return { invitations: [], httpStatus: res.statusCode, ok: false };
    return { invitations: parseSentInvitations(parsed), httpStatus: res.statusCode, ok: true };
}

/** Withdraw one pending invitation by id. Throws only on TRANSPORT failure; classified §4.4. */
export async function withdrawInvitation(
    creds: VoyagerCreds, dispatcher: Dispatcher, invitationId: string,
): Promise<WriteResult> {
    const res = await request(`${VOYAGER.base}${VOYAGER.withdrawInvitationPath(invitationId)}`, {
        method: 'POST',
        headers: {
            ...buildHeaders(creds),
            'content-type': 'application/json; charset=UTF-8',
            referer: `${VOYAGER.base}/mynetwork/invitation-manager/sent/`,
            origin: VOYAGER.base,
        },
        body: '{}',
        dispatcher,
        headersTimeout: HEADERS_TIMEOUT_MS,
        bodyTimeout: BODY_TIMEOUT_MS,
        signal: AbortSignal.timeout(TOTAL_DEADLINE_MS),
    });
    const raw = await drainText(res);
    return classifyWriteResponse(res.statusCode, raw);
}
