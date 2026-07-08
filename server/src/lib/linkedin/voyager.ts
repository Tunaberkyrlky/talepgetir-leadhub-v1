/**
 * Voyager HOT-UPDATE SURFACE (§4).
 *
 * Everything LinkedIn periodically rotates — endpoint paths, decorationIds, headers —
 * lives HERE so a break is a one-file edit, not a hunt. Faz 1 only needs the liveness
 * probe (/voyager/api/me) + the "golden recipe" headers; Faz 2 adds the invite/message
 * endpoints + their decorationIds (which MUST be re-verified live before use).
 */
import { randomBytes, randomUUID } from 'crypto';

export const VOYAGER = {
    base: 'https://www.linkedin.com',

    // Long-stable liveness probe: needs only li_at + csrf. A 200 with a JSON body means
    // the session cookie is alive; the body carries the member's mini-profile identity.
    mePath: '/voyager/api/me',

    // ── WRITE endpoints (Faz 2) — decorationId/queryId rotate; re-verify live (§4). ──
    // Invite (§4.1): verified across 3 independent repos 2025-26. Noteless by default.
    invitePath:
        '/voyager/api/voyagerRelationshipsDashMemberRelationships?action=verifyQuotaAndCreateV2',
    inviteDecorationId:
        'com.linkedin.voyager.dash.deco.relationships.InvitationCreationResultWithInvitee-2',
    // Message (§4.2): new-conversation create. Reply-to-thread (conversationUrn) is Faz 4.
    messagePath: '/voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage',
    // Profile URN resolution (§4.3): the public profile HTML carries the fsd_profile urn
    // in an inline JSON blob — more stable than the CSRF-touchy GraphQL identity endpoint.
    profileHtmlPath: (publicId: string) => `/in/${encodeURIComponent(publicId)}/`,

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

/** LinkedIn caps a connection-request note at 300 chars on ALL plans (§4.1). */
export const INVITE_NOTE_MAX = 300;

/**
 * Build the invite (connection-request) body. Noteless is the DEFAULT (a note over
 * ~5/month is itself a restriction signal, §1) — a customMessage is only added when a
 * non-empty note is passed, and it is HARD-truncated to 300 chars so a caller can never
 * trip LinkedIn's length rejection.
 */
export function buildInvitePayload(profileUrn: string, note?: string): Record<string, unknown> {
    const body: Record<string, unknown> = {
        invitee: { inviteeUnion: { memberProfile: profileUrn } },
    };
    const trimmed = (note ?? '').trim();
    if (trimmed) body.customMessage = trimmed.slice(0, INVITE_NOTE_MAX);
    return body;
}

/**
 * trackingId: LinkedIn expects a 16-CODE-POINT string, each code point a random byte
 * value 0-255 — NOT a UUID and NOT base64 (either of those classifies as a bare 400,
 * §4.2). We map each random byte through String.fromCharCode; JSON.stringify emits every
 * code point as UTF-8 and LinkedIn's JSON parser decodes it back to the SAME code point,
 * so the 16-code-point sequence round-trips intact (the Tom-Quirk linkedin-api recipe).
 * HOT-UPDATE: if messages start 400-ing, re-verify this shape first.
 */
export function randomTrackingId(): string {
    const bytes = randomBytes(16);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
}

export interface MessageParams {
    /** The sender's own fsd_profile urn (member_urn resolved at validate) = mailboxUrn. */
    mailboxUrn: string;
    /** The recipient's fsd_profile urn. */
    recipientUrn: string;
    text: string;
}

/**
 * Build a NEW-conversation message body (§4.2). originToken is a plain uuid-v4;
 * trackingId follows randomTrackingId. Reply-to-existing-thread (conversationUrn instead
 * of hostRecipientUrns) is a Faz-4 refinement once poll/threads exist.
 */
export function buildMessagePayload(p: MessageParams): Record<string, unknown> {
    return {
        message: {
            body: { attributes: [], text: p.text },
            originToken: randomUUID(),
            renderContentUnions: [],
        },
        mailboxUrn: p.mailboxUrn,
        trackingId: randomTrackingId(),
        dedupeByClientGeneratedToken: false,
        hostRecipientUrns: [p.recipientUrn],
    };
}

/**
 * Extract the OWNER's fsd_profile urn from a public-profile HTML page (§4.3). The page
 * embeds voyager JSON in <code> blobs; the vanity→urn mapping lives under
 * identityDashProfilesByMemberIdentity.
 *
 * SCOPED-ONLY, no broad fallback (codex P1): a profile page also carries OTHER people's
 * fsd_profile urns (suggested/"people also viewed"), so "first urn anywhere" could resolve
 * a real invite onto the wrong person. We only accept a urn tied to the owner's identity
 * key; a miss returns null → the caller SKIPS (never sends to a guessed target). This is
 * the same deterministic-owner discipline as parseMeIdentity. For live sends, passing an
 * explicit profile_urn is preferred over public-id resolution.
 */
export function parseProfileUrnFromHtml(html: string): string | null {
    if (!html) return null;
    const scoped = html.match(
        /identityDashProfilesByMemberIdentity[\s\S]{0,4000}?(urn:li:fsd_profile:[A-Za-z0-9_-]+)/,
    );
    return scoped?.[1] ?? null;
}

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
