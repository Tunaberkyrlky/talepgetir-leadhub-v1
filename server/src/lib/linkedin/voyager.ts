/**
 * Voyager HOT-UPDATE SURFACE (§4).
 *
 * Everything LinkedIn periodically rotates — endpoint paths, decorationIds, headers —
 * lives HERE so a break is a one-file edit, not a hunt. Faz 1 only needs the liveness
 * probe (/voyager/api/me) + the "golden recipe" headers; Faz 2 adds the invite/message
 * endpoints + their decorationIds (which MUST be re-verified live before use).
 */

export const VOYAGER = {
    base: 'https://www.linkedin.com',

    // Long-stable liveness probe: needs only li_at + csrf. A 200 with a JSON body means
    // the session cookie is alive; the body carries the member's mini-profile identity.
    mePath: '/voyager/api/me',

    restliProtocolVersion: '2.0.0',
    accept: 'application/vnd.linkedin.normalized+json+2.1',
    liLang: 'en_US',
    // Placeholder locale header. A real browser XHR always sends accept-language, so
    // omitting it is itself a fingerprint anomaly. Faz 3 captures the account's REAL
    // Accept-Language at connect (beside user_agent) and geo-matches it to the proxy.
    acceptLanguage: 'en-US,en;q=0.9',

    // Fallback UA only. The captured session's REAL user-agent (stored at capture,
    // §3 anti-detection) must override this on every call.
    defaultUserAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
} as const;

/** Strip surrounding quotes from JSESSIONID to form the csrf-token header value. */
export function csrfFromJsessionid(jsessionid: string): string {
    return jsessionid.replace(/"/g, '');
}

export interface VoyagerCreds {
    liAt: string;
    jsessionid: string;
    userAgent: string;
}

/** Standard authenticated Voyager header set (the "golden recipe", §4.1). */
export function buildHeaders(creds: VoyagerCreds): Record<string, string> {
    const csrf = csrfFromJsessionid(creds.jsessionid);
    return {
        cookie: `li_at=${creds.liAt}; JSESSIONID="${csrf}"`,
        'csrf-token': csrf,
        'x-restli-protocol-version': VOYAGER.restliProtocolVersion,
        accept: VOYAGER.accept,
        'accept-language': VOYAGER.acceptLanguage,
        'x-li-lang': VOYAGER.liLang,
        'user-agent': creds.userAgent || VOYAGER.defaultUserAgent,
    };
}

export interface LinkedInIdentity {
    /** urn:li:fsd_profile:<id> — the messaging mailboxUrn (Faz 2). Null if unresolved. */
    memberUrn: string | null;
    /** public/vanity identifier. */
    publicId: string | null;
    /** display name. */
    name: string | null;
}

/**
 * Resolve the logged-in member's identity from a /voyager/api/me normalized response.
 *
 * DETERMINISTIC: follow data['*miniProfile'] (the owner's exact entityUrn) and match THAT
 * element in `included` — never a loose "first profile-ish object" guess, because a
 * wrong-but-nonnull memberUrn is persisted to the unique-indexed member_urn and becomes
 * the Faz-2 messaging mailboxUrn (a wrong one collides / routes messages from the wrong
 * mailbox). Emits memberUrn ONLY from a real fs_miniProfile urn; otherwise null.
 * NEVER throws and NEVER blocks validate.
 */
export function parseMeIdentity(body: unknown): LinkedInIdentity {
    const empty: LinkedInIdentity = { memberUrn: null, publicId: null, name: null };
    if (!body || typeof body !== 'object') return empty;
    const b = body as { data?: Record<string, unknown>; included?: unknown[] };
    const included = Array.isArray(b.included) ? b.included : [];

    const entityUrnOf = (el: unknown): string =>
        el && typeof el === 'object' && typeof (el as Record<string, unknown>).entityUrn === 'string'
            ? ((el as Record<string, unknown>).entityUrn as string)
            : '';

    // 1) Follow the owner pointer when present.
    const ownerUrn = b.data && typeof b.data['*miniProfile'] === 'string'
        ? (b.data['*miniProfile'] as string)
        : null;
    let mp: Record<string, unknown> | undefined;
    if (ownerUrn) {
        mp = included.find((el) => entityUrnOf(el) === ownerUrn) as Record<string, unknown> | undefined;
    }
    // 2) Fallback: exactly ONE mini-profile in the response (unambiguous owner).
    if (!mp) {
        const minis = included.filter((el) => entityUrnOf(el).startsWith('urn:li:fs_miniProfile:'));
        if (minis.length === 1) mp = minis[0] as Record<string, unknown>;
    }
    if (!mp) return empty;

    const urn = entityUrnOf(mp);
    const idMatch = urn.match(/urn:li:fs_miniProfile:([^,)\s]+)/);
    const id = idMatch ? idMatch[1] : null;
    const publicId = typeof mp.publicIdentifier === 'string' ? mp.publicIdentifier : null;
    const first = typeof mp.firstName === 'string' ? mp.firstName : '';
    const last = typeof mp.lastName === 'string' ? mp.lastName : '';
    const name = `${first} ${last}`.trim() || null;

    return { memberUrn: id ? `urn:li:fsd_profile:${id}` : null, publicId, name };
}
