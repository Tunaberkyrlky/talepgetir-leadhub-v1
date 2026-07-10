/**
 * IMAP inbound — polls each tenant's connected IMAP mailbox and ingests
 * replies that match a known company/contact (same pipeline as the PlusVibe
 * webhook, but matched-only to avoid pulling personal/unrelated mail).
 *
 * Tracking: last_seen_uid per connection (UID-based, not UNSEEN — so reading a
 * mail in the client doesn't make us miss it). UIDVALIDITY changes reset the
 * baseline. The first poll only records a baseline UID (no backfill).
 */
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { supabaseAdmin } from './supabase.js';
import { createLogger } from './logger.js';
import { decrypt } from './encryption.js';
import { listPollableImapConnections, type EmailConnection } from './emailConnections.js';
import { matchSenderEmail, advanceCompanyStageOnMatch } from './emailMatcher.js';
import { cancelEnrollmentOnReply, markEmailBounced } from './campaignEngine.js';
import { parseImapInbound } from './mail/imapAdapter.js';
import { detectBounce } from './mail/bounceDetector.js';
import { canonicalToReplyRow, splitEmailBody } from './mail/types.js';
import { resolvePublicHost } from './ssrfGuard.js';

const log = createLogger('imapInbound');

const POLL_CONCURRENCY = 5;     // max simultaneous IMAP connections
const MAX_PER_POLL = 200;       // safety cap on messages processed per connection per tick

interface PollResult { processed: number; matched: number; }

async function updateConnState(id: string, lastSeenUid: number, uidValidity: number): Promise<void> {
    await supabaseAdmin
        .from('email_connections')
        .update({
            last_seen_uid: lastSeenUid,
            last_uid_validity: uidValidity,
            last_polled_at: new Date().toISOString(),
        })
        .eq('id', id);
}

async function ingestMessage(conn: EmailConnection, uid: number, source: Buffer): Promise<boolean> {
    const parsed = await simpleParser(source);

    // ── Bounce (DSN) tespiti (task-5) ─────────────────────────────────────────
    // Bu mail bir teslim başarısızlığı bildirimi mi? DSN'ler mailer-daemon/postmaster'dan
    // gelir ve normal eşleşmeye takılmadan düşerdi. KALICI (hard) bounce'ta başarısız
    // alıcıyı bastırma listesine yazıp o adresin enrollment'larını 'bounced' yaparız.
    // Gönderen kutusu = DSN'in düştüğü kutu (conn.email_address) → oto-duraklatma için mailbox.
    // Bounce her hâlde reply olarak SAKLANMAZ (return false).
    const bounce = detectBounce(parsed, source);
    if (bounce.isBounce) {
        if (bounce.hard && bounce.recipient) {
            await markEmailBounced({
                tenantId: conn.tenant_id,
                email: bounce.recipient,
                mailbox: conn.email_address,
            }).catch((err) => log.warn({ err, account: conn.email_address, recipient: bounce.recipient }, 'markEmailBounced (IMAP) failed'));
            log.info({ account: conn.email_address, recipient: bounce.recipient }, 'Hard bounce detected & suppressed');
        } else {
            log.info({ account: conn.email_address, recipient: bounce.recipient, hard: bounce.hard }, 'Bounce detected (soft/unresolved) — not suppressed');
        }
        return false;
    }

    const canonical = parseImapInbound(parsed, conn.email_address, conn.tenant_id);
    canonical.providerMessageId = String(uid);

    if (!canonical.senderEmail) return false;
    const sender = canonical.senderEmail.toLowerCase().trim();

    const match = await matchSenderEmail(canonical.senderEmail, conn.tenant_id);
    const isMatched = match.tenant_id === conn.tenant_id && match.match_status === 'matched';

    // Keep a mail if EITHER it matches a known company/contact, OR we started the
    // conversation — i.e. we already sent an outbound mail to this address (compose/
    // reply/forward). This lets replies from not-yet-registered people show up too.
    let weWroteThem = false;
    if (!isMatched) {
        const { count } = await supabaseAdmin
            .from('email_replies')
            .select('id', { count: 'exact', head: true })
            .eq('tenant_id', conn.tenant_id)
            .eq('direction', 'OUT')
            .eq('sender_email', sender);
        weWroteThem = !!count;
    }
    if (!isMatched && !weWroteThem) return false; // not matched and we never wrote to them → drop

    canonical.bodyText = canonical.bodyText ? splitEmailBody(canonical.bodyText).fresh : null;
    canonical.bodyHtml = null; // keep bulky HTML out of columns
    canonical.occurredAt = canonical.occurredAt || new Date().toISOString();

    const row = {
        ...canonicalToReplyRow(canonical),
        company_id: match.company_id,
        contact_id: match.contact_id,
        match_status: match.match_status,
        match_method: match.match_method,
        read_status: 'unread',
    };

    const { error } = await supabaseAdmin.from('email_replies').insert(row);
    if (error) {
        if (error.code === '23505') return false; // rfc_message_id dedup — already have it
        log.error({ err: error, account: conn.email_address, uid }, 'IMAP reply insert failed');
        return false;
    }

    if (match.company_id) {
        await advanceCompanyStageOnMatch(match.company_id).catch((err) =>
            log.warn({ err, companyId: match.company_id }, 'advanceCompanyStageOnMatch failed'));
    }
    cancelEnrollmentOnReply(canonical.senderEmail, conn.tenant_id).catch((err) =>
        log.warn({ err, sender: canonical.senderEmail }, 'cancelEnrollmentOnReply failed'));

    return true;
}

async function pollConnection(conn: EmailConnection): Promise<PollResult> {
    if (!conn.imap_host || !conn.imap_port || !conn.username || !conn.encrypted_password) {
        return { processed: 0, matched: 0 };
    }

    // SSRF guard: resolve to a validated public IP and dial that literal (not the
    // hostname), so a tenant can't DNS-rebind imap_host to an internal address
    // between save and poll. servername keeps TLS cert validation on the hostname.
    const pinned = await resolvePublicHost(conn.imap_host);
    const client = new ImapFlow({
        host: pinned.address,
        port: conn.imap_port,
        secure: conn.imap_secure ?? true,
        auth: { user: conn.username, pass: decrypt(conn.encrypted_password) },
        tls: {
            servername: pinned.servername,
            ...(conn.allow_invalid_cert && { rejectUnauthorized: false }),
        },
        logger: false,
        // Fail fast so one dead host doesn't stall the whole tick.
        socketTimeout: 20_000,
        greetingTimeout: 10_000,
        connectionTimeout: 10_000,
    });

    // ImapFlow is an EventEmitter: an async transport failure (e.g. a socket
    // timeout fired from the socket's own timer) is delivered as an 'error'
    // event, separately from the rejection of whatever command is in flight.
    // With no 'error' listener, Node re-throws that emit as an uncaught
    // exception — off our await chain, so neither the try/finally below nor the
    // caller's Promise.allSettled can catch it. Attach a listener so the error
    // is logged and swallowed; the in-flight await still rejects and is handled
    // normally by pollConnection's caller.
    client.on('error', (err) =>
        log.warn({ err, account: conn.email_address }, 'IMAP client error (async)'));

    let processed = 0;
    let matched = 0;

    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
        const uidValidity = Number(client.mailbox && typeof client.mailbox !== 'boolean' ? client.mailbox.uidValidity : 0);
        const uidNext = Number(client.mailbox && typeof client.mailbox !== 'boolean' ? client.mailbox.uidNext : 0);

        let lastSeenUid = conn.last_seen_uid ?? 0;
        // UIDVALIDITY changed → all old UIDs are void, re-baseline.
        if (conn.last_uid_validity && conn.last_uid_validity !== uidValidity) {
            lastSeenUid = 0;
        }

        // First poll (or post-reset): record a baseline, don't backfill history.
        // Replies arriving AFTER this are picked up on the next tick.
        if (lastSeenUid === 0) {
            const baseline = Math.max(0, uidNext - 1);
            await updateConnState(conn.id, baseline, uidValidity);
            log.info({ account: conn.email_address, baseline, uidValidity }, 'IMAP baseline set (first poll)');
            return { processed: 0, matched: 0 };
        }

        const fetchRange = `${lastSeenUid + 1}:*`;
        log.info({ account: conn.email_address, lastSeenUid, uidNext }, 'IMAP connected, fetching new messages');

        let maxUid = lastSeenUid;
        for await (const msg of client.fetch({ uid: fetchRange }, { uid: true, source: true })) {
            // IMAP `start:*` can echo the last message when start > highest UID — guard it.
            if (lastSeenUid > 0 && msg.uid <= lastSeenUid) continue;
            if (processed >= MAX_PER_POLL) break;
            maxUid = Math.max(maxUid, msg.uid);
            processed++;
            try {
                if (await ingestMessage(conn, msg.uid, msg.source as Buffer)) matched++;
            } catch (err) {
                log.warn({ err, account: conn.email_address, uid: msg.uid }, 'IMAP message ingest failed');
            }
        }

        await updateConnState(conn.id, maxUid, uidValidity);
    } finally {
        lock.release();
        await client.logout().catch(() => { /* best effort */ });
    }

    return { processed, matched };
}

/** One scheduler tick: poll every IMAP-capable connection across all tenants. */
export async function processImapPolling(): Promise<void> {
    const conns = await listPollableImapConnections();
    log.info({ connections: conns.length }, 'IMAP poll tick started');
    if (conns.length === 0) return;

    let totalProcessed = 0;
    let totalMatched = 0;

    for (let i = 0; i < conns.length; i += POLL_CONCURRENCY) {
        const batch = conns.slice(i, i + POLL_CONCURRENCY);
        const results = await Promise.allSettled(batch.map((c) => pollConnection(c)));
        results.forEach((r, idx) => {
            if (r.status === 'fulfilled') {
                totalProcessed += r.value.processed;
                totalMatched += r.value.matched;
            } else {
                log.warn({ err: r.reason, account: batch[idx].email_address }, 'IMAP poll failed for connection');
            }
        });
    }

    log.info({ connections: conns.length, processed: totalProcessed, matched: totalMatched }, 'IMAP poll tick done');
}

/**
 * Verify IMAP credentials by connecting, opening INBOX, and logging out.
 * Throws on auth/connection failure — the connect flow calls this before saving
 * so typos/missing app-passwords fail fast. SSRF-guarded the same way as
 * pollConnection: resolve to a validated public IP and dial that literal.
 */
export async function verifyImap(opts: {
    host: string;
    port: number;
    secure: boolean;
    username: string;
    password: string;
    allowInvalidCert?: boolean;
}): Promise<void> {
    const pinned = await resolvePublicHost(opts.host);
    const client = new ImapFlow({
        host: pinned.address,
        port: opts.port,
        secure: opts.secure,
        auth: { user: opts.username, pass: opts.password },
        tls: {
            servername: pinned.servername,
            ...(opts.allowInvalidCert && { rejectUnauthorized: false }),
        },
        logger: false,
        socketTimeout: 20_000,
        greetingTimeout: 10_000,
        connectionTimeout: 10_000,
    });
    // Swallow async 'error' events (see pollConnection); the connect()/lock
    // promise rejection is what we surface to the caller.
    client.on('error', () => { /* handled via await rejection */ });
    await client.connect();
    try {
        const lock = await client.getMailboxLock('INBOX');
        lock.release();
    } finally {
        await client.logout().catch(() => { /* best effort */ });
    }
}
