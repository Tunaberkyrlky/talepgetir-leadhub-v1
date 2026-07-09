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

    // ── Pending-invite withdrawal (Faz 3, §2 "davet hijyeni") — HOT-SURFACE, RE-VERIFY LIVE. ──
    // List the account's OUTGOING pending invitations, then withdraw the stale ones. These
    // paths rotate like every voyager write; both are marked for live re-verification (this
    // module has no live account yet, so the withdraw handler is DRY-RUN-default until proven).
    sentInvitationsPath: (start = 0, count = 100) =>
        `/voyager/api/relationships/sentInvitationViewsV2?count=${count}&start=${start}`,
    // Withdraw one invitation by its numeric id (action=withdraw on the same collection).
    withdrawInvitationPath: (invitationId: string) =>
        `/voyager/api/relationships/sentInvitationViewsV2/${encodeURIComponent(invitationId)}?action=withdraw`,

    // ── Poll detection (Faz 4, §2/§5) — HOT-SURFACE, RE-VERIFY LIVE (unproven, like withdraw). ──
    // 1st-degree connections (invite ACCEPT detection): a lead's profile urn appearing here
    // means the invite was accepted → the sequence can advance to the message step.
    connectionsPath: (start = 0, count = 100) =>
        `/voyager/api/relationships/connectionsV2?count=${count}&start=${start}`,
    // Conversations (REPLY detection): a conversation whose latest message is INCOMING (not
    // from our mailbox) means the lead replied → global stop + suppress (§5).
    conversationsPath: (count = 40) =>
        `/voyager/api/messaging/conversations?count=${count}`,

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
    /** The cookie's REAL browser Accept-Language (§3). Falls back to VOYAGER.acceptLanguage. */
    acceptLanguage?: string | null;
}

/** Standard authenticated Voyager header set (the "golden recipe", §4.1). */
export function buildHeaders(creds: VoyagerCreds): Record<string, string> {
    const csrf = csrfFromJsessionid(creds.jsessionid);
    return {
        cookie: `li_at=${creds.liAt}; JSESSIONID="${csrf}"`,
        'csrf-token': csrf,
        'x-restli-protocol-version': VOYAGER.restliProtocolVersion,
        accept: VOYAGER.accept,
        // Replay the account's captured Accept-Language verbatim (§3); the static default is
        // only a fallback for pre-Faz-3 accounts that never captured one.
        'accept-language': creds.acceptLanguage || VOYAGER.acceptLanguage,
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

export interface SentInvitation {
    /** Numeric invitation id used to build the withdraw path. */
    invitationId: string;
    /** Full invitation urn (advisory / audit). */
    invitationUrn: string;
    /** Epoch ms the invite was sent, if the response carried it; null otherwise. */
    sentAtMs: number | null;
}

/**
 * Extract OUTGOING pending invitations from a sentInvitationViews response (§2 withdrawal).
 * HOT-SURFACE (voyager rotates the shape): scan BOTH the top-level `elements` and the
 * normalized `included` array for invitation entities (urn:li:fs_invitation:<id> or the
 * dash fsd_invitation variant), pulling the numeric id and a sent timestamp when present.
 * Deduplicates by id. A miss returns [] — the caller withdraws nothing rather than guessing.
 */
export function parseSentInvitations(body: unknown): SentInvitation[] {
    if (!body || typeof body !== 'object') return [];
    const b = body as { elements?: unknown[]; included?: unknown[] };
    const pools: unknown[] = [
        ...(Array.isArray(b.elements) ? b.elements : []),
        ...(Array.isArray(b.included) ? b.included : []),
    ];
    const byId = new Map<string, SentInvitation>();

    const readEntity = (raw: Record<string, unknown>): void => {
        // The invitation urn may be on the object itself or on a nested `invitation` field.
        const nested = (raw.invitation && typeof raw.invitation === 'object')
            ? raw.invitation as Record<string, unknown> : null;
        const node = nested ?? raw;
        const urn = typeof node.entityUrn === 'string' ? node.entityUrn : '';
        const m = urn.match(/urn:li:fs[d]?_invitation:(\d+)/);
        if (!m) return;
        const invitationId = m[1];
        // sentTime / sentAt appears as epoch ms on the invitation entity in most shapes.
        const t = node.sentTime ?? node.sentAt ?? (nested ? raw.sentTime : undefined);
        const sentAtMs = typeof t === 'number' && Number.isFinite(t) ? t : null;
        const existing = byId.get(invitationId);
        if (!existing) byId.set(invitationId, { invitationId, invitationUrn: urn, sentAtMs });
        else if (existing.sentAtMs == null && sentAtMs != null) existing.sentAtMs = sentAtMs;
    };

    for (const el of pools) {
        if (el && typeof el === 'object') readEntity(el as Record<string, unknown>);
    }
    return [...byId.values()];
}

/**
 * Extract the set of 1st-degree connection profile urns from a connectionsV2 response (§5
 * accept detection). HOT-SURFACE: scan elements + included for fsd_profile urns. A miss
 * returns an empty set — the caller then simply detects no new accepts (never a false accept).
 */
export function parseConnectionUrns(body: unknown): Set<string> {
    const out = new Set<string>();
    if (!body || typeof body !== 'object') return out;
    const b = body as { elements?: unknown[]; included?: unknown[] };
    const scan = (arr: unknown[] | undefined) => {
        if (!Array.isArray(arr)) return;
        for (const el of arr) {
            const s = JSON.stringify(el);
            const re = /urn:li:fsd_profile:[A-Za-z0-9_-]+/g;
            let m: RegExpExecArray | null;
            while ((m = re.exec(s)) !== null) out.add(m[0]);
        }
    };
    scan(b.elements);
    scan(b.included);
    return out;
}

export interface ConversationSummary {
    /** fsd_profile urns of the OTHER participants (our own mailbox urn excluded by the caller). */
    participantUrns: string[];
    /** True when the newest message in the thread was NOT sent by us (an incoming reply). */
    incoming: boolean;
}

/**
 * Extract conversation summaries from a messaging/conversations response (§5 reply detection).
 * HOT-SURFACE + BEST-EFFORT: normalized messaging shapes vary, so we read each element's
 * participant urns and a direction hint (unread count, or a lastMessage/events sender that
 * differs from our mailbox). `myMailboxUrn` lets the caller's incoming test exclude self-sends.
 * A miss yields []. Reply detection is UNVERIFIED against a live account — treat conservatively.
 */
export function parseConversations(body: unknown, myMailboxUrn: string | null): ConversationSummary[] {
    if (!body || typeof body !== 'object') return [];
    const b = body as { elements?: unknown[] };
    if (!Array.isArray(b.elements)) return [];
    const out: ConversationSummary[] = [];
    const profileRe = /urn:li:fsd_profile:[A-Za-z0-9_-]+/g;
    for (const el of b.elements) {
        if (!el || typeof el !== 'object') continue;
        const o = el as Record<string, unknown>;
        const s = JSON.stringify(o);
        const urns = new Set<string>();
        let m: RegExpExecArray | null;
        while ((m = profileRe.exec(s)) !== null) urns.add(m[0]);
        const others = [...urns].filter((u) => u !== myMailboxUrn);
        if (others.length === 0) continue;
        // Direction hint: an unread count > 0 is the most portable "there is something incoming".
        const unread = typeof o.unreadCount === 'number' ? o.unreadCount
            : typeof o.unreadMessageCount === 'number' ? o.unreadMessageCount : 0;
        out.push({ participantUrns: others, incoming: unread > 0 });
    }
    return out;
}
