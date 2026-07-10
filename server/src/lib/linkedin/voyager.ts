/**
 * Voyager HOT-UPDATE SURFACE (§4).
 *
 * Everything LinkedIn periodically rotates — endpoint paths, decorationIds, headers —
 * lives HERE so a break is a one-file edit, not a hunt. Faz 1 only needs the liveness
 * probe (/voyager/api/me) + the "golden recipe" headers; Faz 2 adds the invite/message
 * endpoints + their decorationIds (which MUST be re-verified live before use).
 */
import { randomBytes, randomUUID } from 'crypto';

/**
 * GraphQL persisted-query id for the Messenger conversations-list finder
 * (`messengerConversationsByCategory*`). HOT-UPDATE, HIGHEST volatility constant
 * in this file: LinkedIn ships a new hash on practically every web deploy (two
 * independent capture dates already disagree — see the comment on
 * VOYAGER.conversationsPath). RE-VERIFY LIVE before trusting a poll result.
 * Source (2026-04-25 capture, claimed live-verified): vicnaum/linkedin-toolkit
 * references/endpoints.md §5 / lnx/api/endpoints.py CONVERSATION_QUERY_ID.
 */
export const CONVERSATIONS_QUERY_ID = 'messengerConversations.9501074288a12f3ae9e3c7ea243bccbf';

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
    // Profile URN resolution (§4.3): resolve a vanity/public id to the OWNER's fsd_profile
    // urn via the authenticated identity API, keyed by the exact memberIdentity. VERIFIED
    // LIVE (2026-07-09): the public profile HTML no longer carries the owner urn under a
    // stable anchor — it now embeds OTHER people's urns (SDUI "people also viewed"), so
    // HTML scraping would resolve the wrong person. This query returns only the queried
    // member, so matching publicIdentifier is deterministic and safe.
    profileByIdentityPath: (publicId: string) =>
        `/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(publicId)}`,

    // ── Pending-invite withdrawal (Faz 3, §2 "davet hijyeni") — HOT-SURFACE. ──
    // LIVE-CONFIRMED STALE 2026-07-10 on staging: a real dry-run withdraw got
    // `{"skipped":"list_unavailable","http_status":400}` from the OLD path below
    // (`sentInvitationViewsV2?count=&start=`, no `q=` finder key). RE-VERIFY LIVE
    // before trusting withdraw again — see the confidence notes per path.
    //
    // List the account's OUTGOING pending invitations (list, GET). FIX (best-guess,
    // STRONGLY corroborated — not yet proven against OUR live account): the bare
    // collection GET 400s because LinkedIn's Rest.li resource requires an explicit
    // finder key (`q=`) — three independent, currently-maintained (2025-2026)
    // reverse-engineering repos agree on `q=invitationType&invitationType=CONNECTION`
    // for this exact collection:
    //   - https://github.com/eilonmore/linkedin-private-api/blob/master/src/requests/invitation.request.ts
    //     (getSentInvitations: q:'invitationType', invitationType:'CONNECTION')
    //   - https://github.com/stanvanrooy/linkauto/blob/master/linkauto/api/mixins/relationship.py
    //     (relationship_invitation_get SENT branch: same q/invitationType pair)
    //   - https://github.com/bcharleson/linkedincli/blob/main/src/commands/connections/connections.ts
    //     (connections_sent handler: identical start/count/invitationType/q)
    // RE-VERIFY LIVE: confirm this specific 400 is gone and a genuinely-pending
    // invite round-trips through the parser (see parseSentInvitations below).
    sentInvitationsPath: (start = 0, count = 100) =>
        `/voyager/api/relationships/sentInvitationViewsV2` +
        `?count=${count}&start=${start}&q=invitationType&invitationType=CONNECTION`,
    // Withdraw one invitation by its numeric id. BEST-GUESS, LOWER confidence than
    // the list fix above: the OLD resource (`sentInvitationViewsV2/{id}?action=withdraw`)
    // appears in ZERO of the ~15 current repos/catalogs surveyed for this task — it is
    // almost certainly just as stale as the list endpoint was. Moved to the LEGACY
    // `relationships/invitations` collection + `action=withdraw`, which IS an exact
    // route-constant match in a decompiled-Android-APK catalog (single source, but
    // real decompiled route constants, not a guess):
    //   - https://github.com/eisbaw/linkedin-rs/blob/main/re/api_endpoint_catalog.md
    //     (`RELATIONSHIPS_INVITATIONS/{id}?action=withdraw`, POST, no body documented)
    //   - corroborating action-enum context (same repo, re/invitations.md):
    //     `InvitationActionManager.ActionType` includes WITHDRAW alongside ACCEPT/IGNORE
    // ALTERNATE CANDIDATE seen live in a maintained 2026 CLI (flag for the live pass):
    //   - https://github.com/bcharleson/linkedincli/blob/main/src/commands/connections/connections.ts
    //     uses `DELETE relationships/invitations/{id}` (no `?action=withdraw`, no body,
    //     different HTTP verb) for the SAME resource — if the POST+action=withdraw below
    //     404s/400s live, try DELETE on the same path before reaching for a new resource.
    // RE-VERIFY LIVE (mandatory, single-source-only fix): withdraw ONE known-stale
    // pending invite on the bound static IP and confirm a 2xx+no-error-envelope.
    withdrawInvitationPath: (invitationId: string) =>
        `/voyager/api/relationships/invitations/${encodeURIComponent(invitationId)}?action=withdraw`,

    // ── Poll detection (Faz 4, §2/§5) — HOT-SURFACE, RE-VERIFY LIVE (unproven, like withdraw). ──
    // 1st-degree connections (invite ACCEPT detection): a lead's profile urn appearing here
    // means the invite was accepted → the sequence can advance to the message step.
    // FIX (best-guess, single toolkit source but with an explicit "verified live 2026-04-25"
    // claim + a full worked response fixture, and consistent with the Dash-resource-naming
    // convention THIS file already proved live for invite/message): moved off the stale
    // `relationships/connectionsV2` collection to the Dash finder:
    //   - https://github.com/vicnaum/linkedin-toolkit/blob/main/references/endpoints.md
    //     (§4 "GET /voyager/api/relationships/dash/connections", full request+response fixture)
    //   - https://github.com/vicnaum/linkedin-toolkit/blob/main/lnx/api/endpoints.py
    //     (`connections_url()` — identical q=search/decorationId/sortType, same repo but
    //     self-consistent across its own docs+code)
    // ALTERNATE CANDIDATE (unverified, no `V2`/`dash`, from a different repo's client.rs
    // whose own task notes say live validation is still pending): `relationships/connections`
    // (no decorationId) — https://github.com/eisbaw/linkedin-rs backlog/tasks/task-0030.md.
    // RE-VERIFY LIVE: confirm a 2xx+JSON and that at least one known 1st-degree connection's
    // fsd_profile urn round-trips through parseConnectionUrns below.
    connectionsPath: (start = 0, count = 100) =>
        `/voyager/api/relationships/dash/connections` +
        `?count=${count}&start=${start}&q=search&sortType=RECENTLY_ADDED` +
        `&decorationId=com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionListWithProfile-16`,
    // Conversations (REPLY detection): a conversation whose latest message is INCOMING (not
    // from our mailbox) means the lead replied → global stop + suppress (§5).
    // FIX (best-guess, structure well-corroborated / exact queryId NOT — queryIds rotate on
    // nearly every LinkedIn deploy by design, see the two DIFFERENT hashes cited below from
    // two different capture dates): the plain REST `messaging/conversations` collection is
    // reported to hard-500 on the current international build and has been replaced by the
    // Messenger GraphQL host (a DIFFERENT base path from /voyager/api/graphql):
    //   - https://github.com/eisbaw/linkedin-rs/blob/main/linkedin/linkedin-api/src/client.rs
    //     (get_conversations(): "the REST endpoint messaging/conversations returns HTTP 500
    //     (deprecated server-side)"; uses queryId messengerConversations.7dc50d3efc3953190125aca9c05f0af6)
    //   - https://github.com/vicnaum/linkedin-toolkit/blob/main/references/endpoints.md (§5,
    //     claims "verified live 2026-04-25"; queryId messengerConversations.9501074288a12f3ae9e3c7ea243bccbf,
    //     same repo's lnx/api/endpoints.py CONVERSATION_QUERY_ID matches self-consistently)
    // We use vicnaum's hash as the shipped default (most detailed worked fixture), but BOTH
    // sources agree the STRUCTURE is: host `/voyager/api/voyagerMessagingGraphQL/graphql`,
    // a REST.li "variables=(...)" structural literal (NOT JSON — the `( ) : ,` structural
    // characters must stay LITERAL in the query string; only the mailboxUrn VALUE itself is
    // percent-encoded, encoding the structure itself yields a 400 per
    // https://github.com/devag7/linkedin-mcp/blob/main/src/browser/endpoints.ts graphqlPath() doc),
    // requiring mailboxUrn (our own fsd_profile urn — already threaded through
    // listConversations(), see client.ts) as a mandatory variable.
    // RE-VERIFY LIVE (highest-uncertainty surface of the four): the queryId WILL likely need
    // a fresh live capture (DevTools → Network → filter `graphql` while opening the inbox)
    // before this can be trusted; treat `conversationsQueryId` as HOT-UPDATE, same as the
    // invite/message decorationIds above.
    conversationsPath: (mailboxUrn: string, count = 40) => {
        const encodedUrn = encodeURIComponent(mailboxUrn);
        const variables =
            `(query:(predicateUnions:List((conversationCategoryPredicate:(category:INBOX)))),` +
            `count:${count},mailboxUrn:${encodedUrn})`;
        return `/voyager/api/voyagerMessagingGraphQL/graphql` +
            `?queryId=${CONVERSATIONS_QUERY_ID}&variables=${variables}`;
    },

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
 * Resolve the OWNER's fsd_profile urn from the identity API's normalized JSON (§4.3),
 * keyed by the exact public/vanity id we queried.
 *
 * DETERMINISTIC + SAFE (codex P1): the response's `included[]` carries profile entities;
 * we accept ONLY the one whose `publicIdentifier` case-insensitively equals the requested
 * id, then return its `entityUrn`. We never take "the first fsd_profile urn" — a page/graph
 * can surface OTHER people (verified live: HTML scraping resolved a "people also viewed"
 * stranger). A miss returns null → the caller SKIPS (never sends to a guessed target).
 */
export function parseProfileUrnFromIdentityJson(text: string, publicId: string): string | null {
    if (!text) return null;
    let json: unknown;
    try { json = JSON.parse(text); } catch { return null; }
    const included = (json as { included?: unknown }).included;
    if (!Array.isArray(included)) return null;
    const want = publicId.toLowerCase();
    for (const el of included) {
        const e = el as { entityUrn?: unknown; publicIdentifier?: unknown };
        if (typeof e.entityUrn !== 'string' || typeof e.publicIdentifier !== 'string') continue;
        if (e.publicIdentifier.toLowerCase() !== want) continue;
        const m = e.entityUrn.match(/^urn:li:fsd_profile:[A-Za-z0-9_-]+$/);
        if (m) return e.entityUrn;
    }
    return null;
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
 * Deduplicates by id.
 *
 * Returns `null` (NOT []) when the envelope carries NEITHER an `elements` NOR an
 * `included` array at all — i.e. this isn't a shape we recognize (LinkedIn rotated it
 * again). The caller (listSentInvitations, client.ts) must treat `null` as a FAILED
 * read (ok:false / list_unavailable), never as "confirmed zero pending invitations" —
 * this is the exact fail-closed behavior that just protected us from the live 2026-07-10
 * 400 (§4.4: never trust an unrecognized 2xx body). A recognized-but-genuinely-empty
 * envelope (arrays present, zero invitation entities inside) still returns [].
 */
export function parseSentInvitations(body: unknown): SentInvitation[] | null {
    if (!body || typeof body !== 'object') return null;
    const b = body as { elements?: unknown[]; included?: unknown[] };
    const hasElements = Array.isArray(b.elements);
    const hasIncluded = Array.isArray(b.included);
    if (!hasElements && !hasIncluded) return null;
    const pools: unknown[] = [
        ...(hasElements ? (b.elements as unknown[]) : []),
        ...(hasIncluded ? (b.included as unknown[]) : []),
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
 * Extract the set of 1st-degree connection profile urns from a
 * relationships/dash/connections response (§5 accept detection). HOT-SURFACE: scan
 * `elements` (legacy/fallback flat shape), `included` (the Dash finder's normalized
 * entity pool — where the actual Connection + Profile records live), AND `data`
 * (the Dash finder nests its urn-ref list under `data['*elements']`, see the source
 * cited on VOYAGER.connectionsPath) for fsd_profile urns, by simple regex over each
 * pool's JSON text rather than modeling exact nested fields — resilient to LinkedIn
 * moving a field one level without changing the profile-urn format itself.
 *
 * Returns `null` when NONE of `elements` / `included` / `data` are present at all —
 * an envelope we don't recognize, which the caller (listConnections, client.ts) must
 * treat as a FAILED read (ok:false), never as "confirmed zero connections" (§4.4
 * fail-closed, same invariant as parseSentInvitations above). A recognized-but-empty
 * envelope still returns an empty Set.
 */
export function parseConnectionUrns(body: unknown): Set<string> | null {
    if (!body || typeof body !== 'object') return null;
    const b = body as { elements?: unknown[]; included?: unknown[]; data?: unknown };
    const hasElements = Array.isArray(b.elements);
    const hasIncluded = Array.isArray(b.included);
    const hasData = b.data != null && typeof b.data === 'object';
    if (!hasElements && !hasIncluded && !hasData) return null;

    const out = new Set<string>();
    const re = /urn:li:fsd_profile:[A-Za-z0-9_-]+/g;
    const scanValue = (val: unknown) => {
        if (val == null) return;
        const s = JSON.stringify(val);
        let m: RegExpExecArray | null;
        while ((m = re.exec(s)) !== null) out.add(m[0]);
    };
    if (hasElements) for (const el of b.elements as unknown[]) scanValue(el);
    if (hasIncluded) for (const el of b.included as unknown[]) scanValue(el);
    if (hasData) scanValue(b.data);
    return out;
}

export interface ConversationSummary {
    /** fsd_profile urns of the OTHER participants (our own mailbox urn excluded by the caller). */
    participantUrns: string[];
    /** True when the newest message in the thread was NOT sent by us (an incoming reply). */
    incoming: boolean;
}

/**
 * Extract conversation summaries from a Messenger GraphQL conversations response (§5 reply
 * detection). HOT-SURFACE + BEST-EFFORT, and the MOST UNCERTAIN of the four surfaces in this
 * file (see VOYAGER.conversationsPath for sources — queryId rotates on nearly every deploy).
 *
 * Handles TWO shapes:
 *  1) The GraphQL envelope: double-wrapped under `data.data.<rootKey>['*elements']` where
 *     `rootKey` fluctuates (`...ByCategoryQuery` / `...ByCategory` / `...BySyncToken` — all
 *     three reported in the wild). Each element is a bare conversation-urn STRING; we resolve
 *     it to its normalized entity via `included[]` (keyed by entityUrn) before reading fields.
 *  2) A flatter/legacy fallback: `elements` directly at the top level, already inline objects
 *     (kept so a future partial-rollback or a REST-shaped response degrades gracefully instead
 *     of returning nothing).
 * If NEITHER shape's ref list is found AND `included` is empty, the caller cannot trust
 * anything in the body → returns `null` (an unrecognized envelope), which listConversations
 * (client.ts) MUST treat as a FAILED read (ok:false), never as "confirmed empty inbox" (§4.4
 * fail-closed, same invariant as the other two parsers above).
 *
 * Per-conversation extraction is still best-effort regex-over-JSON (not exact field modeling):
 * we don't have a live-confirmed shape for WHERE participant profile urns live relative to a
 * Conversation entity in the normalized graph, so we JSON.stringify whatever entity we resolved
 * and scan broadly. This is intentionally the SAFE failure direction: if a real reply's
 * participant urn isn't reachable in one hop, we simply MISS the conversation (no `incoming`
 * flag fires, no participant urns returned) — an under-detect, not a false-positive. Because a
 * detected `incoming` is what triggers the global stop+suppress (§5), under-detection costs at
 * most one extra poll cycle, never a wrong stop. `myMailboxUrn` lets the caller's incoming test
 * exclude self-sends; a `null` myMailboxUrn or a resolution miss still runs (self may then leak
 * into `participantUrns`, which the caller already tolerates per the original contract).
 */
export function parseConversations(body: unknown, myMailboxUrn: string | null): ConversationSummary[] | null {
    if (!body || typeof body !== 'object') return null;
    const root = body as Record<string, unknown>;

    // §Q-FLUCTUATING-ROOT-KEY / §Q-DATA-DOUBLE-WRAP (see VOYAGER.conversationsPath sources).
    const ROOT_KEYS = [
        'messengerConversationsByCategoryQuery',
        'messengerConversationsByCategory',
        'messengerConversationsBySyncToken',
    ] as const;
    const layer1 = root.data && typeof root.data === 'object' ? (root.data as Record<string, unknown>) : null;
    const layer2 = layer1?.data && typeof layer1.data === 'object' ? (layer1.data as Record<string, unknown>) : null;

    let elementsRefs: unknown[] | null = null;
    for (const key of ROOT_KEYS) {
        const node = (layer2?.[key] ?? layer1?.[key]) as Record<string, unknown> | undefined;
        const refs = node?.['*elements'];
        if (Array.isArray(refs)) { elementsRefs = refs; break; }
    }
    // Fallback: a flatter/legacy shape with elements directly at top level.
    if (elementsRefs == null) {
        const flat = (root as { elements?: unknown }).elements;
        if (Array.isArray(flat)) elementsRefs = flat;
    }

    // A recognized ref list is REQUIRED (a GraphQL `*elements` array or a legacy top-level
    // `elements` array). Without one the envelope is unrecognized — voyager rotated the shape
    // again — which is NOT an empty inbox and NOT a licence to treat arbitrary `included`
    // entities as conversations: an unrelated entity that happens to carry a lead's fsd_profile
    // urn plus an unread flag would otherwise read as a false INCOMING reply and wrongly trigger
    // the §5 global stop+suppress (codex P1). Fail closed instead (→ ok:false / list_unavailable).
    if (elementsRefs == null) return null;
    const included = Array.isArray(root.included) ? (root.included as unknown[]) : [];

    const includedByUrn = new Map<string, unknown>();
    for (const el of included) {
        const urn = el && typeof el === 'object' ? (el as Record<string, unknown>).entityUrn : undefined;
        if (typeof urn === 'string') includedByUrn.set(urn, el);
    }

    // Only the recognized ref list is processed — never a blind sweep of every `included`
    // entity (see the fail-closed guard above; codex P1).
    const refs: unknown[] = elementsRefs;
    const profileRe = /urn:li:fsd_profile:[A-Za-z0-9_-]+/g;
    const out: ConversationSummary[] = [];
    for (const ref of refs) {
        // New shape: ref is a bare conversation-urn STRING, resolve via included[].
        // Legacy fallback shape: ref may already BE the inline conversation object.
        const entity = typeof ref === 'string' ? includedByUrn.get(ref) : ref;
        if (!entity || typeof entity !== 'object') continue;
        const o = entity as Record<string, unknown>;
        const s = JSON.stringify(o);
        const urns = new Set<string>();
        let m: RegExpExecArray | null;
        while ((m = profileRe.exec(s)) !== null) urns.add(m[0]);
        const others = [...urns].filter((u) => u !== myMailboxUrn);
        if (others.length === 0) continue;
        // Direction hint: an unread count > 0 / read===false is the most portable "something
        // incoming" signal (see VOYAGER.conversationsPath source for the `read`/`unreadCount`
        // fields on the normalized Conversation entity).
        const unread = typeof o.unreadCount === 'number' ? o.unreadCount
            : typeof o.unreadMessageCount === 'number' ? o.unreadMessageCount : 0;
        out.push({ participantUrns: others, incoming: unread > 0 || o.read === false });
    }
    return out;
}
