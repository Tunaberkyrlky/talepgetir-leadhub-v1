import { Router, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { supabaseAdmin, createUserClient } from '../lib/supabase.js';
import { requireRole } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { createLogger } from '../lib/logger.js';
import {
    validateBody,
    assignReplySchema,
    emailRepliesQuerySchema,
    readStatusBodySchema,
    sendReplyBodySchema,
    forwardEmailBodySchema,
    composeEmailBodySchema,
    threadHistoryQuerySchema,
    trackingStatsQuerySchema,
    uuidField,
} from '../lib/validation.js';
import { z } from 'zod/v4';
import { isInternalRole } from '../lib/roles.js';
import { matchSenderEmail, advanceCompanyStageOnMatch } from '../lib/emailMatcher.js';
import { resolveReplyContext } from '../lib/plusvibeReplyResolver.js';
import { buildAttachmentCardsHtml, plainTextToParagraphs } from '../lib/emailHtmlBuilder.js';
import { injectTracking, isTrackingConfigured } from '../lib/mailTracking.js';
import { sendMail, willSupportAttachments } from '../lib/mail/router.js';
import { resolveThreadMailbox } from '../lib/mail/resolveThreadMailbox.js';
import { useThreadV2 } from '../lib/mail/threadReadFlag.js';
import { resolveLiveSenderMailbox } from '../lib/plusvibeSenderMailbox.js';
import { getConnectionByEmail, getDefaultConnection } from '../lib/emailConnections.js';
import type { CanonicalAttachment, CanonicalSendRequest, MailChannel, MailProviderName, SendResult } from '../lib/mail/types.js';

const log = createLogger('route:email-replies');
const router = Router();

const idParamSchema = z.object({ id: uuidField('Invalid reply ID') });

// Issue 17: guard against missing auth context (always set by authMiddleware, but fail explicitly)
function dbClient(req: Request) {
    if (!req.user || !req.accessToken) {
        throw new AppError('Authentication required', 401);
    }
    if (isInternalRole(req.user.role)) return supabaseAdmin;
    return createUserClient(req.accessToken);
}

// Single place every send path (reply/forward/compose) wires open/click tracking,
// so a future 4th path can't silently skip it or let the pixel and the
// raw_payload.tracked marker drift apart. Pre-generates the OUT row id the
// pixel/click token references, injects tracking into the body, and reports
// whether a pixel was actually embedded.
function prepareOutboundTracking(html: string): {
    outId: string;
    html: string;
    trackedMarker: { tracked: true } | Record<string, never>;
} {
    const outId = randomUUID();
    return {
        outId,
        html: injectTracking(html, outId, 'reply'),
        trackedMarker: isTrackingConfigured() ? { tracked: true } : {},
    };
}

// Office formats can't render natively in a browser tab, so we route them
// through the Microsoft Office Online viewer (renders xlsx/docx/pptx in-page).
const OFFICE_PREVIEW_EXTS = new Set(['xls', 'xlsx', 'doc', 'docx', 'ppt', 'pptx']);

// The URL a link card's "Görüntüle" button opens — a browser PREVIEW, not a
// download. Uploaded Office files go through the Office Online viewer; PDFs,
// images and text preview inline straight from the public URL (Supabase serves
// them inline). External URL-only templates (Drive/Docs links) already point at
// their own viewer, so they're left untouched.
function attachmentCardUrl(t: { file_type: string; file_url: string; storage_path?: string | null }): string {
    if (!t.storage_path) return t.file_url;
    const ext = (t.file_type || '').replace(/^\./, '').toLowerCase();
    if (OFFICE_PREVIEW_EXTS.has(ext)) {
        return `https://view.officeapps.live.com/op/view.aspx?src=${encodeURIComponent(t.file_url)}`;
    }
    return t.file_url;
}

/**
 * Resolve selected attachment templates for an outbound send into:
 *  - cardsHtml: link-card HTML to append to the body (URL-only templates, files
 *    too big for the channel, or channels without real-attachment support),
 *  - attachments: real-file candidates the router loads + attaches.
 * Capability is probed against the SAME provider sendMail will resolve. Cards
 * are appended to the body BEFORE tracking; real attachments carry no link.
 */
async function resolveOutboundAttachments(
    attachmentIds: string[] | undefined,
    tenantId: string,
    shape: { channel: MailChannel; accountEmail?: string | null; originProvider?: MailProviderName; inReplyToMessageId?: string | null },
): Promise<{ cardsHtml: string; attachments: CanonicalAttachment[]; missing: number }> {
    if (!attachmentIds?.length) return { cardsHtml: '', attachments: [], missing: 0 };

    const { data: templates } = await supabaseAdmin
        .from('email_attachment_templates')
        .select('label, file_type, file_url, file_size, storage_path, size_bytes, original_filename')
        .in('id', attachmentIds)
        .eq('tenant_id', tenantId)
        .eq('is_active', true);
    // Selected ids that no longer resolve to an active template (deleted, or wrong
    // tenant) would silently not be sent — count them so the caller can warn.
    const missing = attachmentIds.length - (templates?.length ?? 0);
    if (!templates?.length) return { cardsHtml: '', attachments: [], missing };

    const cap = await willSupportAttachments({
        tenantId,
        channel: shape.channel,
        accountEmail: shape.accountEmail,
        originProvider: shape.originProvider,
        inReplyToMessageId: shape.inReplyToMessageId,
        to: '', subject: '', bodyHtml: '',
    });

    const attachments: CanonicalAttachment[] = [];
    const cards: { label: string; file_type: string; file_url: string; file_size: string }[] = [];
    for (const t of templates) {
        const fits = typeof t.size_bytes === 'number' && t.size_bytes <= cap.maxBytes;
        // Real attachment only for uploaded files (storage_path) on a capable,
        // size-fitting channel; everything else degrades to a link card.
        if (cap.supported && t.storage_path && fits) {
            attachments.push({
                label: t.label,
                fileType: t.file_type,
                fileSize: t.file_size,
                fileUrl: t.file_url,
                storagePath: t.storage_path,
                sizeBytes: t.size_bytes,
                originalFilename: t.original_filename,
            });
        } else {
            cards.push({ label: t.label, file_type: t.file_type, file_url: attachmentCardUrl(t), file_size: t.file_size });
        }
    }
    return { cardsHtml: buildAttachmentCardsHtml(cards), attachments, missing };
}

/**
 * Build the client-facing attachment warning when some selected files did NOT make
 * it onto a successfully-sent message — either unresolved templates (`missing`) or
 * files the router couldn't load (`dropped`). Returns undefined when all is well.
 */
function buildAttachmentWarning(
    missing: number,
    dropped: string[] | undefined,
): { failed: string[]; missingCount: number } | undefined {
    const failed = dropped ?? [];
    if (!failed.length && missing <= 0) return undefined;
    return { failed, missingCount: Math.max(0, missing) };
}

/** PlusVibe rejects a send from a rotated-out / deleted mailbox with this exact 400. */
function isDeletedMailboxError(err: unknown): boolean {
    return err instanceof AppError && /email account has been deleted/i.test(err.message);
}

export interface MailboxNotice { previous: string; current: string }

/**
 * Send a PlusVibe reply/forward, healing the "sending mailbox was deleted" case.
 *
 * Cold-email domains rotate: PlusVibe deletes burned mailboxes, so a thread's
 * stored sending mailbox may no longer exist. On that specific 400 we swap in a
 * live campaign account (same person when possible) and retry ONCE. A second
 * failure means the thread can't be answered via PlusVibe at all (reply_to_id is
 * likely bound to the deleted account) — we surface a clear error rather than
 * looping through every account. Returns the mailbox actually used plus a notice
 * to show the user when a substitution happened.
 */
async function sendPlusvibeWithMailboxHeal(
    req: CanonicalSendRequest,
    campaignId: string,
): Promise<{ result: SendResult; accountEmail: string; mailboxNotice?: MailboxNotice }> {
    const desired = req.accountEmail!;
    try {
        const result = await sendMail(req);
        return { result, accountEmail: desired };
    } catch (err) {
        if (!isDeletedMailboxError(err)) throw err;

        const live = await resolveLiveSenderMailbox(campaignId, desired);
        if (!live.substituted) throw err; // desired reported live — nothing to swap, rethrow original

        try {
            const result = await sendMail({ ...req, accountEmail: live.email });
            log.info({ campaignId, previous: desired, current: live.email }, 'Reply sent after healing deleted mailbox');
            return { result, accountEmail: live.email, mailboxNotice: { previous: desired, current: live.email } };
        } catch (retryErr) {
            log.error(
                { err: retryErr, campaignId, previous: desired, current: live.email },
                'PlusVibe send failed even after substituting a live mailbox',
            );
            throw new AppError(
                'This conversation cannot be answered via PlusVibe: the original sending mailbox was deleted and the fallback mailbox also failed.',
                409,
            );
        }
    }
}

// GET /api/email-replies — threaded list (latest email per sender+campaign)
// Returns thread_count and has_unread alongside each row.
router.get(
    '/',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;

            const queryResult = emailRepliesQuerySchema.safeParse(req.query);
            if (!queryResult.success) {
                res.status(400).json({ error: 'Invalid query parameters' });
                return;
            }
            const { page, limit, campaign_id, match_status, read_status, date_from, date_to, search, label, sentiment, awaiting } = queryResult.data;
            const offset = (page - 1) * limit;
            const isAwaiting = awaiting === 'true';

            const rpcParams = {
                p_tenant_id: tenantId,
                p_offset: offset,
                p_limit: limit,
                p_campaign_id: campaign_id || null,
                p_match_status: match_status || null,
                p_read_status: read_status || null,
                p_search: search || null,
                p_date_from: date_from || null,
                p_date_to: date_to || null,
                p_label: label || null,
                p_sentiment: sentiment || null,
                p_awaiting: isAwaiting,
            };

            // Faz 4 rollout: per-tenant flag picks the unified thread model (v2) vs
            // legacy (sender_email, campaign_id) grouping. Same param + return shape.
            const v2 = useThreadV2(tenantId);
            const [{ data: rows, error }, { data: countData, error: countError }] = await Promise.all([
                supabaseAdmin.rpc(v2 ? 'get_threads_v2' : 'get_email_reply_threads', rpcParams),
                supabaseAdmin.rpc(v2 ? 'count_threads_v2' : 'count_email_reply_threads', {
                    p_tenant_id: tenantId,
                    p_campaign_id: campaign_id || null,
                    p_match_status: match_status || null,
                    p_read_status: read_status || null,
                    p_search: search || null,
                    p_date_from: date_from || null,
                    p_date_to: date_to || null,
                    p_label: label || null,
                    p_sentiment: sentiment || null,
                    p_awaiting: isAwaiting,
                }),
            ]);

            if (error || countError) {
                log.error({ err: error || countError }, 'List email replies (threaded) error');
                throw new AppError('Failed to fetch email replies', 500);
            }

            // Resolve company and contact names
            const list = rows || [];
            const companyIds = [...new Set(list.map((r: any) => r.company_id).filter(Boolean))];
            const contactIds = [...new Set(list.map((r: any) => r.contact_id).filter(Boolean))];

            const companyMap: Record<string, { name: string; stage: string | null; website: string | null }> = {};
            const activityCountMap: Record<string, number> = {};
            const contactMap: Record<string, string> = {};

            if (companyIds.length > 0) {
                const [{ data: companies }, { data: activities }] = await Promise.all([
                    supabaseAdmin
                        .from('companies')
                        .select('id, name, stage, website')
                        .eq('tenant_id', tenantId)
                        .in('id', companyIds),
                    supabaseAdmin
                        .from('activities')
                        .select('company_id')
                        .eq('tenant_id', tenantId)
                        .in('company_id', companyIds),
                ]);
                for (const c of companies || []) {
                    companyMap[c.id] = { name: c.name, stage: c.stage ?? null, website: c.website ?? null };
                }
                for (const a of activities || []) {
                    activityCountMap[a.company_id] = (activityCountMap[a.company_id] ?? 0) + 1;
                }
            }

            if (contactIds.length > 0) {
                const { data: contacts } = await supabaseAdmin
                    .from('contacts')
                    .select('id, first_name, last_name')
                    .eq('tenant_id', tenantId)
                    .in('id', contactIds);
                for (const c of contacts || []) {
                    contactMap[c.id] = [c.first_name, c.last_name].filter(Boolean).join(' ');
                }
            }

            const mapped = list.map((r: any) => ({
                ...r,
                company_name: r.company_id ? (companyMap[r.company_id]?.name || null) : null,
                company_stage: r.company_id ? (companyMap[r.company_id]?.stage ?? null) : null,
                company_website: r.company_id ? (companyMap[r.company_id]?.website ?? null) : null,
                company_activity_count: r.company_id ? (activityCountMap[r.company_id] ?? 0) : null,
                contact_name: r.contact_id ? (contactMap[r.contact_id] || null) : null,
            }));

            const total = Number(countData) || 0;
            res.json({
                data: mapped,
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages: Math.ceil(total / limit),
                    hasNext: page < Math.ceil(total / limit),
                    hasPrev: page > 1,
                },
            });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'List email replies error');
            next(new AppError('Failed to fetch email replies', 500));
        }
    }
);

// GET /api/email-replies/thread-history — older messages in a thread
// Returns all replies from the same sender+campaign, excluding the latest (exclude_id).
router.get(
    '/thread-history',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const queryResult = threadHistoryQuerySchema.safeParse(req.query);
            if (!queryResult.success) {
                res.status(400).json({ error: 'Invalid query parameters' });
                return;
            }
            const { sender_email, campaign_id, exclude_id } = queryResult.data;
            const tenantId = req.tenantId!;

            // Faz 4: for v2 tenants show the whole UNIFIED thread (by thread_id resolved
            // from the representative row), so a merged thread reveals every message.
            // Fall back to the legacy (sender_email, campaign_id) grouping otherwise.
            let threadId: string | null = null;
            if (useThreadV2(tenantId) && exclude_id) {
                const { data: rep } = await supabaseAdmin
                    .from('email_replies').select('thread_id')
                    .eq('tenant_id', tenantId).eq('id', exclude_id).single();
                threadId = (rep?.thread_id as string | null) ?? null;
            }

            let query = supabaseAdmin
                .from('email_replies')
                .select('id, sender_email, reply_body, replied_at, read_status, campaign_id, direction, raw_payload, account_email, from_address, to_address, cc_address, provider')
                .eq('tenant_id', tenantId)
                .order('replied_at', { ascending: false })
                .limit(50);

            if (threadId) {
                query = query.eq('thread_id', threadId);
            } else {
                query = query.eq('sender_email', sender_email);
                if (campaign_id) query = query.eq('campaign_id', campaign_id);
            }
            if (exclude_id) query = query.neq('id', exclude_id);

            // Exclude drafts. NULL-safe: a plain `not(...cs...)` drops rows where
            // raw_payload IS NULL (e.g. IMAP-ingested replies) because NOT(NULL) = NULL.
            query = query.or('raw_payload.is.null,raw_payload->>source.neq.draft');

            const { data, error } = await query;
            if (error) {
                log.error({ err: error }, 'Thread history error');
                throw new AppError('Failed to fetch thread history', 500);
            }

            // Attach open/click tracking to OUT messages (single extra query;
            // the thread is capped at 50 rows so .in() stays small).
            const rows = data || [];
            const outIds = rows.filter((r: any) => r.direction === 'OUT').map((r: any) => r.id);
            const trackingMap: Record<string, {
                open_count: number; click_count: number;
                first_opened_at: string | null; first_clicked_at: string | null;
            }> = {};
            if (outIds.length) {
                const { data: events } = await supabaseAdmin
                    .from('campaign_email_events')
                    .select('email_reply_id, event_type, created_at')
                    .in('email_reply_id', outIds)
                    .in('event_type', ['open', 'click']);
                for (const ev of (events || []) as { email_reply_id: string; event_type: string; created_at: string }[]) {
                    const t = trackingMap[ev.email_reply_id]
                        ?? (trackingMap[ev.email_reply_id] = { open_count: 0, click_count: 0, first_opened_at: null, first_clicked_at: null });
                    if (ev.event_type === 'open') {
                        t.open_count++;
                        if (!t.first_opened_at || ev.created_at < t.first_opened_at) t.first_opened_at = ev.created_at;
                    } else {
                        t.click_count++;
                        if (!t.first_clicked_at || ev.created_at < t.first_clicked_at) t.first_clicked_at = ev.created_at;
                    }
                }
            }

            // Resolve attachment templates referenced by OUT messages (raw_payload
            // .attachment_ids) so the thread can show each file's name/size/type and an
            // open link. Templates deleted since the send resolve to { missing: true }.
            const attIds = new Set<string>();
            for (const r of rows as any[]) {
                const ids = r.raw_payload?.attachment_ids;
                if (Array.isArray(ids)) for (const x of ids) if (typeof x === 'string') attIds.add(x);
            }
            const attMap: Record<string, { id: string; label: string; file_type: string; file_size: string; is_file: boolean; open_url: string }> = {};
            if (attIds.size) {
                const { data: tpls } = await supabaseAdmin
                    .from('email_attachment_templates')
                    .select('id, label, file_type, file_url, file_size, storage_path, original_filename')
                    .in('id', [...attIds])
                    .eq('tenant_id', tenantId);
                for (const tpl of (tpls || []) as any[]) {
                    attMap[tpl.id] = {
                        id: tpl.id,
                        label: tpl.original_filename || tpl.label,
                        file_type: tpl.file_type,
                        file_size: tpl.file_size,
                        is_file: !!tpl.storage_path,
                        open_url: attachmentCardUrl(tpl),
                    };
                }
            }

            res.json(rows.map((r: any) => {
                const ids = r.raw_payload?.attachment_ids;
                const attachments = Array.isArray(ids)
                    ? ids.filter((x: unknown) => typeof x === 'string').map((id: string) => attMap[id] ?? { id, missing: true })
                    : [];
                return { ...r, tracking: trackingMap[r.id] ?? null, attachments };
            }));
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Thread history error');
            next(new AppError('Failed to fetch thread history', 500));
        }
    }
);

// GET /api/email-replies/stats — summary statistics
// Issue 6: restricted to non-viewer roles
// Issue 10: single aggregation via RPC instead of 4 separate COUNTs
router.get(
    '/stats',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;

            const queryResult = trackingStatsQuerySchema.safeParse(req.query);
            if (!queryResult.success) {
                res.status(400).json({ error: 'Invalid query parameters' });
                return;
            }
            const { date_from, date_to } = queryResult.data;

            const { data, error } = await supabaseAdmin
                .rpc('get_email_reply_stats', {
                    p_tenant_id: tenantId,
                    p_date_from: date_from ?? null,
                    p_date_to: date_to ?? null,
                })
                .single();

            if (error) {
                log.error({ err: error }, 'Email replies stats error');
                throw new AppError('Failed to fetch stats', 500);
            }

            const stats = data as {
                total: number; unread: number; matched: number; unmatched: number;
                interested: number; awaiting: number;
            };
            res.json({
                total: Number(stats.total),
                unread: Number(stats.unread),
                matched: Number(stats.matched),
                unmatched: Number(stats.unmatched),
                interested: Number(stats.interested),
                awaiting: Number(stats.awaiting),
            });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Email replies stats error');
            next(new AppError('Failed to fetch stats', 500));
        }
    }
);

// GET /api/email-replies/tracking-stats — open/click aggregate for outbound singles
router.get(
    '/tracking-stats',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;

            const queryResult = trackingStatsQuerySchema.safeParse(req.query);
            if (!queryResult.success) {
                res.status(400).json({ error: 'Invalid query parameters' });
                return;
            }
            const { date_from, date_to } = queryResult.data;

            const { data, error } = await supabaseAdmin
                .rpc('get_email_reply_tracking_stats', {
                    p_tenant_id: tenantId,
                    p_date_from: date_from ?? null,
                    p_date_to: date_to ?? null,
                })
                .single();

            if (error) {
                log.error({ err: error }, 'Email tracking stats error');
                throw new AppError('Failed to fetch tracking stats', 500);
            }

            const stats = data as { sent: number; opened: number; clicked: number };
            const sent = Number(stats.sent);
            const opened = Number(stats.opened);
            const clicked = Number(stats.clicked);
            res.json({
                sent,
                opened,
                clicked,
                open_rate: sent > 0 ? opened / sent : 0,
                click_rate: sent > 0 ? clicked / sent : 0,
            });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Email tracking stats error');
            next(new AppError('Failed to fetch tracking stats', 500));
        }
    }
);

// GET /api/email-replies/campaigns — distinct campaign list for filter dropdown
// Issue 6: restricted to non-viewer roles
router.get(
    '/campaigns',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;
            const db = dbClient(req);

            const { data, error } = await db
                .from('email_replies')
                .select('campaign_id, campaign_name')
                .eq('tenant_id', tenantId)
                .not('campaign_id', 'is', null)
                .order('replied_at', { ascending: false })
                .limit(500);

            if (error) {
                log.error({ err: error }, 'Email replies campaigns error');
                throw new AppError('Failed to fetch campaigns', 500);
            }

            // Deduplicate by campaign_id
            const seen = new Set<string>();
            const campaigns = (data || []).filter((r: any) => {
                if (seen.has(r.campaign_id)) return false;
                seen.add(r.campaign_id);
                return true;
            });

            res.json(campaigns);
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Email replies campaigns error');
            next(new AppError('Failed to fetch campaigns', 500));
        }
    }
);

// PATCH /api/email-replies/:id/read — set read status explicitly
// Issue 2: UUID validation on :id
// Issue 5 (Option A): client sends desired status; eliminates fetch-then-write race condition
// Issue 11: standardized response shape
router.patch(
    '/:id/read',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    validateBody(readStatusBodySchema),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const paramResult = idParamSchema.safeParse(req.params);
            if (!paramResult.success) {
                res.status(400).json({ error: 'Invalid reply ID' });
                return;
            }
            const { id } = paramResult.data;
            const { read_status } = req.body;
            const tenantId = req.tenantId!;
            const db = dbClient(req);

            // read_status is conceptually THREAD-level: the list row's unread flag is
            // BOOL_OR over the thread's inbound messages. Toggling a single reply leaves a
            // multi-message thread still unread, so the optimistic UI reverts on refetch.
            // Resolve the target's thread (sender + campaign) and move ALL its inbound
            // messages together.
            const { data: target, error: findErr } = await db
                .from('email_replies')
                .select('sender_email, campaign_id, thread_id')
                .eq('id', id)
                .eq('tenant_id', tenantId)
                .single();

            if (findErr || !target) {
                if ((findErr as any)?.code === 'PGRST116') {
                    throw new AppError('Email reply not found', 404);
                }
                if (findErr) {
                    log.error({ err: findErr }, 'Set read status (lookup) error');
                    throw new AppError('Failed to update read status', 500);
                }
                throw new AppError('Email reply not found', 404);
            }

            let upd = db
                .from('email_replies')
                .update({ read_status })
                .eq('tenant_id', tenantId)
                .eq('direction', 'IN');
            // Faz 4: v2 tenants move the whole unified thread; legacy uses sender+campaign.
            if (useThreadV2(tenantId) && (target as { thread_id?: string | null }).thread_id) {
                upd = upd.eq('thread_id', (target as { thread_id?: string | null }).thread_id!);
            } else {
                upd = upd.eq('sender_email', target.sender_email);
                upd = target.campaign_id === null
                    ? upd.is('campaign_id', null)
                    : upd.eq('campaign_id', target.campaign_id);
            }

            const { error } = await upd;
            if (error) {
                log.error({ err: error }, 'Set read status error');
                throw new AppError('Failed to update read status', 500);
            }

            res.json({ id, read_status });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Set read status error');
            next(new AppError('Failed to update read status', 500));
        }
    }
);

// PATCH /api/email-replies/:id/assign — manually assign company/contact
// Issue 1: verify company belongs to user's tenant before assigning
// Issue 2: UUID validation on :id
// Issue 11: standardized response shape
router.patch(
    '/:id/assign',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    validateBody(assignReplySchema),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const paramResult = idParamSchema.safeParse(req.params);
            if (!paramResult.success) {
                res.status(400).json({ error: 'Invalid reply ID' });
                return;
            }
            const { id } = paramResult.data;
            const { company_id, contact_id } = req.body;
            const tenantId = req.tenantId!;
            const db = dbClient(req);

            // Issue 1: verify company belongs to this tenant
            const { data: company, error: companyErr } = await db
                .from('companies')
                .select('id')
                .eq('id', company_id)
                .eq('tenant_id', tenantId)
                .single();

            if (companyErr || !company) {
                throw new AppError('Company not found in your workspace', 404);
            }

            // If contact provided, verify it belongs to this company
            if (contact_id) {
                const { data: contact, error: contactErr } = await db
                    .from('contacts')
                    .select('id')
                    .eq('id', contact_id)
                    .eq('company_id', company_id)
                    .single();

                if (contactErr || !contact) {
                    throw new AppError('Contact not found for this company', 404);
                }
            }

            const { data, error } = await db
                .from('email_replies')
                .update({
                    company_id,
                    contact_id: contact_id || null,
                    match_status: 'matched',
                    match_method: 'manual',
                })
                .eq('id', id)
                .eq('tenant_id', tenantId)
                .select('id, read_status, match_status, company_id, contact_id, updated_at')
                .single();

            if (error) {
                if ((error as any).code === 'PGRST116') {
                    throw new AppError('Email reply not found', 404);
                }
                log.error({ err: error, id, tenantId }, 'Assign company error');
                throw new AppError('Failed to assign company', 500);
            }
            if (!data) {
                throw new AppError('Email reply not found', 404);
            }


            await advanceCompanyStageOnMatch(company_id);

            res.json(data);
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Assign company error');
            next(new AppError('Failed to assign company', 500));
        }
    }
);

// POST /api/email-replies/rematch-batch — re-run matching for a specific set of reply IDs
// Used by the frontend bulk-rematch flow to process in chunks and show progress.
router.post(
    '/rematch-batch',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;
            const ids: unknown = req.body.ids;

            if (!Array.isArray(ids) || ids.length === 0 || ids.length > 50) {
                res.status(400).json({ error: 'ids must be a non-empty array of up to 50 UUIDs' });
                return;
            }
            const validIds = ids.filter((id) => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id));
            if (validIds.length === 0) {
                res.status(400).json({ error: 'No valid UUIDs provided' });
                return;
            }

            const { data: replies, error: fetchErr } = await supabaseAdmin
                .from('email_replies')
                .select('id, sender_email')
                .in('id', validIds)
                .eq('tenant_id', tenantId);

            if (fetchErr) throw new AppError('Failed to fetch replies', 500);

            // Group by sender_email to call matchSenderEmail once per sender
            const bySender = new Map<string, string[]>();
            for (const r of replies || []) {
                const arr = bySender.get(r.sender_email) || [];
                arr.push(r.id);
                bySender.set(r.sender_email, arr);
            }


            let matched = 0;

            for (const [senderEmail, senderIds] of bySender) {
                let match;
                try {
                    match = await matchSenderEmail(senderEmail, tenantId);
                } catch {
                    continue;
                }
                if (match.match_status !== 'matched') continue;

                const { error: updateErr } = await supabaseAdmin
                    .from('email_replies')
                    .update({
                        company_id: match.company_id,
                        contact_id: match.contact_id,
                        match_status: 'matched',
                        match_method: match.match_method,
                    })
                    .in('id', senderIds)
                    .eq('tenant_id', tenantId);

                if (!updateErr) {
                    matched += senderIds.length;
                    if (match.company_id) await advanceCompanyStageOnMatch(match.company_id);
                }
            }

            res.json({ matched, processed: validIds.length });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Rematch-batch error');
            next(new AppError('Failed to process batch', 500));
        }
    }
);

// POST /api/email-replies/rematch-all — re-run matching for all unmatched replies in the tenant
// Groups by unique sender_email to avoid redundant matchSenderEmail calls.
router.post(
    '/rematch-all',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;

            // Fetch all unmatched replies (id + sender_email only)
            const { data: unmatched, error: fetchErr } = await supabaseAdmin
                .from('email_replies')
                .select('id, sender_email')
                .eq('tenant_id', tenantId)
                .eq('match_status', 'unmatched');

            if (fetchErr) {
                log.error({ err: fetchErr }, 'Rematch-all fetch error');
                throw new AppError('Failed to fetch unmatched replies', 500);
            }

            if (!unmatched || unmatched.length === 0) {
                res.json({ matched: 0, stillUnmatched: 0, total: 0 });
                return;
            }

            // Group reply ids by sender_email to call matchSenderEmail once per sender
            const bySender = new Map<string, string[]>();
            for (const r of unmatched) {
                const ids = bySender.get(r.sender_email) || [];
                ids.push(r.id);
                bySender.set(r.sender_email, ids);
            }



            let matchedCount = 0;
            let stillUnmatched = 0;

            // Process each unique sender sequentially to avoid hammering the DB
            for (const [senderEmail, ids] of bySender) {
                let match;
                try {
                    match = await matchSenderEmail(senderEmail, tenantId);
                } catch (matchErr) {
                    log.warn({ err: matchErr, senderEmail }, 'Rematch-all: sender match failed, skipping');
                    stillUnmatched += ids.length;
                    continue;
                }

                if (match.match_status === 'matched') {
                    const { error: updateErr } = await supabaseAdmin
                        .from('email_replies')
                        .update({
                            company_id: match.company_id,
                            contact_id: match.contact_id,
                            match_status: 'matched',
                            match_method: match.match_method,
                        })
                        .in('id', ids)
                        .eq('tenant_id', tenantId);

                    if (updateErr) {
                        log.warn({ err: updateErr, senderEmail }, 'Rematch-all: update failed for sender');
                        stillUnmatched += ids.length;
                    } else {
                        matchedCount += ids.length;
                        if (match.company_id) await advanceCompanyStageOnMatch(match.company_id);
                    }
                } else {
                    stillUnmatched += ids.length;
                }
            }

            log.info({ tenantId, matchedCount, stillUnmatched, total: unmatched.length }, 'Rematch-all completed');
            res.json({ matched: matchedCount, stillUnmatched, total: unmatched.length });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Rematch-all error');
            next(new AppError('Failed to rematch all replies', 500));
        }
    }
);

// POST /api/email-replies/:id/rematch — re-run automatic email matching for a single reply
router.post(
    '/:id/rematch',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const paramResult = idParamSchema.safeParse(req.params);
            if (!paramResult.success) {
                res.status(400).json({ error: 'Invalid reply ID' });
                return;
            }
            const { id } = paramResult.data;
            const tenantId = req.tenantId!;
            const db = dbClient(req);

            // Fetch the reply to get the sender email
            const { data: existing, error: fetchErr } = await db
                .from('email_replies')
                .select('id, sender_email')
                .eq('id', id)
                .eq('tenant_id', tenantId)
                .single();

            if (fetchErr || !existing) {
                throw new AppError('Email reply not found', 404);
            }

            // Re-run matching

            const match = await matchSenderEmail(existing.sender_email, tenantId);

            const { data, error } = await db
                .from('email_replies')
                .update({
                    company_id: match.company_id,
                    contact_id: match.contact_id,
                    match_status: match.match_status,
                    match_method: match.match_method,
                })
                .eq('id', id)
                .eq('tenant_id', tenantId)
                .select('id, read_status, match_status, company_id, contact_id, updated_at')
                .single();

            if (error) {
                log.error({ err: error }, 'Rematch update error');
                throw new AppError('Failed to update match', 500);
            }

            if (match.company_id && match.match_status === 'matched') {
                await advanceCompanyStageOnMatch(match.company_id);
            }

            res.json(data);
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Rematch error');
            next(new AppError('Failed to rematch email reply', 500));
        }
    }
);

// POST /api/email-replies/:id/reply — send a reply via PlusVibe
router.post(
    '/:id/reply',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    validateBody(sendReplyBodySchema),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const paramResult = idParamSchema.safeParse(req.params);
            if (!paramResult.success) {
                res.status(400).json({ error: 'Invalid reply ID' });
                return;
            }
            const { id } = paramResult.data;
            const { body: replyText, attachmentIds, cc } = req.body as { body: string; attachmentIds?: string[]; cc?: string };
            const tenantId = req.tenantId!;

            // Fetch the inbound email reply
            const { data: emailReply, error: fetchErr } = await supabaseAdmin
                .from('email_replies')
                .select('id, campaign_id, sender_email, replied_at, raw_payload, company_id, contact_id, campaign_name, direction, account_email')
                .eq('id', id)
                .eq('tenant_id', tenantId)
                .single();

            if (fetchErr || !emailReply) {
                throw new AppError('Email reply not found', 404);
            }

            if (emailReply.direction === 'OUT') {
                throw new AppError('Cannot reply to an outbound email', 400);
            }

            if (!emailReply.campaign_id) {
                throw new AppError('Cannot reply — no campaign linked to this email', 400);
            }

            // Tenant isolation: verify campaign exists and belongs to this tenant
            const { data: campaign } = await supabaseAdmin
                .from('plusvibe_campaigns')
                .select('id, tenant_id')
                .eq('pv_campaign_id', emailReply.campaign_id)
                .single();

            if (!campaign) {
                throw new AppError('Campaign not found. Please sync campaigns first.', 404);
            }
            if (campaign.tenant_id && campaign.tenant_id !== tenantId) {
                throw new AppError('Campaign does not belong to this tenant', 403);
            }

            // Resolve PlusVibe email ID, from-address, and subject

            const context = await resolveReplyContext(emailReply, tenantId);

            // Convert plain text to simple HTML
            let htmlBody = plainTextToParagraphs(replyText);

            // Ensure subject starts with "Re: "
            const subject = context.subject.startsWith('Re:')
                ? context.subject
                : `Re: ${context.subject}`;

            // Canonical "our mailbox" for this thread (account_email column → fallback to resolver).
            // This fixes replies going out from the wrong (sender_emails[0]) mailbox.
            // This is the DESIRED sender; the heal wrapper below may swap it for a live
            // campaign account if PlusVibe reports it deleted (cold-email domain rotation).
            const desiredMailbox = resolveThreadMailbox(emailReply) ?? context.fromAddress;

            // Real file where the channel supports it (PlusVibe reply does), link
            // card otherwise. Cards must be appended BEFORE tracking wraps links.
            const { cardsHtml, attachments, missing: missingAttachments } = await resolveOutboundAttachments(attachmentIds, tenantId, {
                channel: 'reply',
                accountEmail: desiredMailbox,
                originProvider: 'plusvibe',
                inReplyToMessageId: context.plusvibeEmailId,
            });
            htmlBody += cardsHtml;

            // Tracking pixel/click token references this id; the row is only
            // inserted after a successful send.
            const { outId, html: trackedHtml, trackedMarker } = prepareOutboundTracking(htmlBody);
            htmlBody = trackedHtml;

            // Send via the canonical mail router (reply → PlusVibe for a PlusVibe thread).
            // The heal wrapper auto-substitutes a live mailbox if the stored one was
            // deleted; `accountEmail` is therefore the mailbox actually sent from.
            const { result: sendResult, accountEmail, mailboxNotice } = await sendPlusvibeWithMailboxHeal({
                channel: 'reply',
                tenantId,
                originProvider: 'plusvibe',
                inReplyToMessageId: context.plusvibeEmailId,
                accountEmail: desiredMailbox,
                to: emailReply.sender_email,
                subject,
                bodyHtml: htmlBody,
                ...(cc && { cc: cc.split(',').map((s) => s.trim()).filter(Boolean) }),
                ...(attachments.length && { attachments }),
            }, emailReply.campaign_id);

            // Some selected attachments may not have made it onto the sent mail.
            const warning = buildAttachmentWarning(missingAttachments, sendResult.droppedAttachments);

            // Insert outbound reply record (canonical columns + legacy raw_payload)
            const outRow = {
                id: outId,
                tenant_id: tenantId,
                campaign_id: emailReply.campaign_id,
                campaign_name: emailReply.campaign_name,
                sender_email: emailReply.sender_email,
                reply_body: replyText,
                replied_at: new Date().toISOString(),
                company_id: emailReply.company_id,
                contact_id: emailReply.contact_id,
                match_status: emailReply.company_id ? 'matched' : 'unmatched',
                read_status: 'read' as const,
                direction: 'OUT' as const,
                parent_reply_id: id,
                provider: 'plusvibe',
                channel: 'reply',
                provider_message_id: sendResult.providerMessageId,
                account_email: accountEmail,
                from_address: accountEmail,
                to_address: emailReply.sender_email,
                cc_address: cc || null,
                subject,
                raw_payload: {
                    source: 'user_reply',
                    plusvibe_reply_id: sendResult.providerMessageId,
                    from_address: accountEmail,
                    subject,
                    ...trackedMarker,
                    ...(attachmentIds?.length && { attachment_ids: attachmentIds }),
                },
            };

            const { data: inserted, error: insertErr } = await supabaseAdmin
                .from('email_replies')
                .insert(outRow)
                .select('id, direction, reply_body, replied_at, sender_email, campaign_id')
                .single();

            if (insertErr) {
                log.error({ err: insertErr }, 'Failed to store outbound reply');
                // Reply was sent via PlusVibe successfully, but local storage failed
                // Return success with warning
                res.json({ sent: true, stored: false, plusvibe_id: sendResult.providerMessageId, ...(warning && { attachmentWarning: warning }), ...(mailboxNotice && { mailboxNotice }) });
                return;
            }

            // Sent — drop any saved draft for this thread so it doesn't reappear on reopen.
            const { error: draftDelErr } = await supabaseAdmin
                .from('email_replies')
                .delete()
                .eq('parent_reply_id', id)
                .eq('tenant_id', tenantId)
                .eq('direction', 'OUT')
                .contains('raw_payload', { source: 'draft' });
            if (draftDelErr) log.warn({ err: draftDelErr }, 'Draft cleanup after send failed (non-critical)');

            log.info({ replyId: id, outboundId: inserted.id, to: emailReply.sender_email }, 'Reply sent via PlusVibe');
            res.json({ sent: true, stored: true, data: inserted, ...(warning && { attachmentWarning: warning }), ...(mailboxNotice && { mailboxNotice }) });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Send reply error');
            next(new AppError('Failed to send reply', 500));
        }
    }
);

// POST /api/email-replies/:id/forward — forward an email to a new recipient via PlusVibe
router.post(
    '/:id/forward',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    validateBody(forwardEmailBodySchema),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const paramResult = idParamSchema.safeParse(req.params);
            if (!paramResult.success) {
                res.status(400).json({ error: 'Invalid reply ID' });
                return;
            }
            const { id } = paramResult.data;
            const { to, note, attachmentIds, cc } = req.body as {
                to: string;
                note: string;
                attachmentIds?: string[];
                cc?: string;
            };
            const tenantId = req.tenantId!;

            const { data: emailReply, error: fetchErr } = await supabaseAdmin
                .from('email_replies')
                .select('id, campaign_id, sender_email, replied_at, raw_payload, company_id, contact_id, campaign_name, direction, account_email')
                .eq('id', id)
                .eq('tenant_id', tenantId)
                .single();

            if (fetchErr || !emailReply) {
                throw new AppError('Email reply not found', 404);
            }

            if (!emailReply.campaign_id) {
                throw new AppError('Cannot forward — no campaign linked to this email', 400);
            }

            const { data: campaign } = await supabaseAdmin
                .from('plusvibe_campaigns')
                .select('id, tenant_id')
                .eq('pv_campaign_id', emailReply.campaign_id)
                .single();

            if (!campaign) {
                throw new AppError('Campaign not found. Please sync campaigns first.', 404);
            }
            if (campaign.tenant_id && campaign.tenant_id !== tenantId) {
                throw new AppError('Campaign does not belong to this tenant', 403);
            }

            const context = await resolveReplyContext(emailReply, tenantId);

            // Note becomes the body PlusVibe appends ABOVE the forwarded message
            let htmlBody = plainTextToParagraphs(note);

            // Desired sender; heal wrapper swaps for a live account if it was deleted.
            const desiredMailbox = resolveThreadMailbox(emailReply) ?? context.fromAddress;

            // PlusVibe forward has no attachment API → everything degrades to a
            // link card (real attachment only on channels that support forward).
            const { cardsHtml, attachments, missing: missingAttachments } = await resolveOutboundAttachments(attachmentIds, tenantId, {
                channel: 'forward',
                accountEmail: desiredMailbox,
                originProvider: 'plusvibe',
                inReplyToMessageId: context.plusvibeEmailId,
            });
            htmlBody += cardsHtml;

            const { outId, html: trackedHtml, trackedMarker } = prepareOutboundTracking(htmlBody);
            htmlBody = trackedHtml;

            const { result: sendResult, accountEmail, mailboxNotice } = await sendPlusvibeWithMailboxHeal({
                channel: 'forward',
                tenantId,
                originProvider: 'plusvibe',
                inReplyToMessageId: context.plusvibeEmailId,
                accountEmail: desiredMailbox,
                to,
                subject: context.subject,
                bodyHtml: htmlBody,
                ...(cc && { cc: cc.split(',').map((s) => s.trim()).filter(Boolean) }),
                ...(attachments.length && { attachments }),
            }, emailReply.campaign_id);

            // Some selected attachments may not have made it onto the sent mail.
            const warning = buildAttachmentWarning(missingAttachments, sendResult.droppedAttachments);

            // Outbound record — sender_email kept as ORIGINAL sender so the forward
            // stays under the same thread in the UI. forwarded_to is in raw_payload.
            const outRow = {
                id: outId,
                tenant_id: tenantId,
                campaign_id: emailReply.campaign_id,
                campaign_name: emailReply.campaign_name,
                sender_email: emailReply.sender_email,
                reply_body: note,
                replied_at: new Date().toISOString(),
                company_id: emailReply.company_id,
                contact_id: emailReply.contact_id,
                match_status: emailReply.company_id ? 'matched' : 'unmatched',
                read_status: 'read' as const,
                direction: 'OUT' as const,
                parent_reply_id: id,
                provider: 'plusvibe',
                channel: 'forward',
                provider_message_id: sendResult.providerMessageId,
                account_email: accountEmail,
                from_address: accountEmail,
                to_address: to,
                cc_address: cc || null,
                raw_payload: {
                    source: 'user_forward',
                    plusvibe_forward_id: sendResult.providerMessageId,
                    from_address: accountEmail,
                    forwarded_to: to,
                    ...trackedMarker,
                    ...(cc && { cc }),
                    ...(attachmentIds?.length && { attachment_ids: attachmentIds }),
                },
            };

            const { data: inserted, error: insertErr } = await supabaseAdmin
                .from('email_replies')
                .insert(outRow)
                .select('id, direction, reply_body, replied_at, sender_email, campaign_id')
                .single();

            if (insertErr) {
                log.error({ err: insertErr }, 'Failed to store outbound forward');
                res.json({ sent: true, stored: false, plusvibe_id: sendResult.providerMessageId, ...(warning && { attachmentWarning: warning }), ...(mailboxNotice && { mailboxNotice }) });
                return;
            }

            log.info({ replyId: id, outboundId: inserted.id, forwardedTo: to }, 'Email forwarded via PlusVibe');
            res.json({ sent: true, stored: true, data: inserted, ...(warning && { attachmentWarning: warning }), ...(mailboxNotice && { mailboxNotice }) });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Forward error');
            next(new AppError('Failed to forward email', 500));
        }
    }
);

// POST /api/email-replies/compose — send a brand-new email from the connected Gmail
router.post(
    '/compose',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    validateBody(composeEmailBodySchema),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const { to, subject, body, attachmentIds, cc, companyId, contactId, accountEmail: reqAccount } = req.body as {
                to: string;
                subject: string;
                body: string;
                attachmentIds?: string[];
                cc?: string;
                companyId?: string | null;
                contactId?: string | null;
                accountEmail?: string;
            };
            const tenantId = req.tenantId!;

            // Resolve sender mailbox: explicit "From" selection, else tenant default.
            const connection = reqAccount
                ? await getConnectionByEmail(tenantId, reqAccount)
                : await getDefaultConnection(tenantId);
            if (!connection) {
                throw new AppError(`Email account ${reqAccount} not found or inactive`, 412);
            }
            const accountEmail = connection.email_address;

            // Don't trust client-supplied company/contact IDs — a valid UUID shape
            // is not proof of ownership. Verify both belong to this tenant before
            // attaching them (and derive match_status from the verified company).
            let companyIdSafe: string | null = null;
            let contactIdSafe: string | null = null;
            if (companyId) {
                const { data: co } = await supabaseAdmin
                    .from('companies').select('id')
                    .eq('id', companyId).eq('tenant_id', tenantId).maybeSingle();
                if (!co) throw new AppError('Company not found', 404);
                companyIdSafe = companyId;
            }
            if (contactId) {
                const { data: ct } = await supabaseAdmin
                    .from('contacts').select('id')
                    .eq('id', contactId).eq('tenant_id', tenantId).maybeSingle();
                if (!ct) throw new AppError('Contact not found', 404);
                contactIdSafe = contactId;
            }

            // Plain text body → simple HTML (same pattern as reply/forward)
            let htmlBody = plainTextToParagraphs(body);

            // Real file where the mailbox (Gmail/Outlook/SMTP) supports it, else card.
            const { cardsHtml, attachments, missing: missingAttachments } = await resolveOutboundAttachments(attachmentIds, tenantId, {
                channel: 'compose',
                accountEmail,
            });
            htmlBody += cardsHtml;

            const { outId, html: trackedHtml, trackedMarker } = prepareOutboundTracking(htmlBody);
            htmlBody = trackedHtml;

            const sendResult = await sendMail({
                channel: 'compose',
                tenantId,
                accountEmail,
                to,
                subject,
                bodyHtml: htmlBody,
                ...(cc && { cc: cc.split(',').map((s) => s.trim()).filter(Boolean) }),
                ...(attachments.length && { attachments }),
            });

            // Some selected attachments may not have made it onto the sent mail.
            const warning = buildAttachmentWarning(missingAttachments, sendResult.droppedAttachments);

            // Outbound record — new thread, no parent, no campaign
            const outRow = {
                id: outId,
                tenant_id: tenantId,
                campaign_id: null as string | null,
                campaign_name: null as string | null,
                sender_email: to.toLowerCase().trim(),
                reply_body: body,
                subject,
                replied_at: new Date().toISOString(),
                company_id: companyIdSafe,
                contact_id: contactIdSafe,
                match_status: companyIdSafe ? 'matched' : 'unmatched',
                read_status: 'read' as const,
                direction: 'OUT' as const,
                parent_reply_id: null as string | null,
                provider: sendResult.provider,
                channel: 'compose',
                provider_message_id: sendResult.providerMessageId,
                account_email: accountEmail,
                from_address: accountEmail,
                to_address: to,
                cc_address: cc || null,
                raw_payload: {
                    source: 'user_compose',
                    subject,
                    from_address: accountEmail,
                    ...trackedMarker,
                    ...(cc && { cc }),
                    ...(attachmentIds?.length && { attachment_ids: attachmentIds }),
                },
            };

            const { data: inserted, error: insertErr } = await supabaseAdmin
                .from('email_replies')
                .insert(outRow)
                .select('id, direction, reply_body, replied_at, sender_email, subject')
                .single();

            if (insertErr) {
                log.error({ err: insertErr }, 'Failed to store outbound compose');
                res.json({ sent: true, stored: false, message_id: sendResult.providerMessageId, ...(warning && { attachmentWarning: warning }) });
                return;
            }

            // Activity log (only if matched to a company — unmatched mails have no timeline target)
            if (companyIdSafe) {
                try {
                    await supabaseAdmin.from('activities').insert({
                        tenant_id: tenantId,
                        company_id: companyIdSafe,
                        contact_id: contactIdSafe,
                        created_by: req.user?.id || null,
                        type: 'follow_up',
                        summary: `Mail gönderildi: ${subject}`,
                        detail: body.slice(0, 500),
                        visibility: 'client',
                        occurred_at: new Date().toISOString(),
                    });
                } catch (actErr) {
                    log.warn({ err: actErr, companyId: companyIdSafe }, 'Compose activity log failed (non-critical)');
                }
            }

            log.info({ outboundId: inserted.id, to, subject: subject.slice(0, 50) }, 'Compose email sent via Nango');
            res.json({ sent: true, stored: true, data: inserted, ...(warning && { attachmentWarning: warning }) });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Compose error');
            next(new AppError('Failed to send email', 500));
        }
    }
);

// GET /api/email-replies/:id/draft — get latest draft for this reply
router.get(
    '/:id/draft',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const paramResult = idParamSchema.safeParse(req.params);
            if (!paramResult.success) {
                res.status(400).json({ error: 'Invalid reply ID' });
                return;
            }
            const { id } = paramResult.data;
            const tenantId = req.tenantId!;

            const { data: draft } = await supabaseAdmin
                .from('email_replies')
                .select('id, reply_body, raw_payload, replied_at')
                .eq('parent_reply_id', id)
                .eq('tenant_id', tenantId)
                .eq('direction', 'OUT')
                .contains('raw_payload', { source: 'draft' })
                .order('replied_at', { ascending: false })
                .limit(1)
                .maybeSingle();

            res.json({ draft: draft || null });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            next(new AppError('Failed to fetch draft', 500));
        }
    }
);

// POST /api/email-replies/:id/save-draft — save reply as draft + log activity
router.post(
    '/:id/save-draft',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    validateBody(sendReplyBodySchema),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const paramResult = idParamSchema.safeParse(req.params);
            if (!paramResult.success) {
                res.status(400).json({ error: 'Invalid reply ID' });
                return;
            }
            const { id } = paramResult.data;
            const { body: draftText, attachmentIds, cc } = req.body as { body: string; attachmentIds?: string[]; cc?: string };
            const tenantId = req.tenantId!;

            // Fetch the original email reply
            const { data: emailReply, error: fetchErr } = await supabaseAdmin
                .from('email_replies')
                .select('id, sender_email, company_id, contact_id, campaign_id, campaign_name')
                .eq('id', id)
                .eq('tenant_id', tenantId)
                .single();

            if (fetchErr || !emailReply) {
                throw new AppError('Email reply not found', 404);
            }

            // Upsert ONE draft row per reply thread (keyed by parent_reply_id) so
            // auto-save updates in place instead of piling up duplicate rows. No
            // activity-timeline note: a work-in-progress draft shouldn't show on the
            // (client-visible) timeline, and auto-save would spam it every keystroke.
            const draftPayload = {
                reply_body: draftText,
                replied_at: new Date().toISOString(),
                raw_payload: {
                    source: 'draft',
                    ...(cc && { cc }),
                    ...(attachmentIds?.length && { attachment_ids: attachmentIds }),
                },
            };

            const { data: existing } = await supabaseAdmin
                .from('email_replies')
                .select('id')
                .eq('parent_reply_id', id)
                .eq('tenant_id', tenantId)
                .eq('direction', 'OUT')
                .contains('raw_payload', { source: 'draft' })
                .order('replied_at', { ascending: false })
                .limit(1)
                .maybeSingle();

            let draftId: string;
            if (existing) {
                const { data: updated, error: updErr } = await supabaseAdmin
                    .from('email_replies')
                    .update(draftPayload)
                    .eq('id', existing.id)
                    .eq('tenant_id', tenantId)
                    .select('id')
                    .single();
                if (updErr || !updated) {
                    log.error({ err: updErr }, 'Failed to update draft');
                    throw new AppError('Failed to save draft', 500);
                }
                draftId = updated.id;
            } else {
                const { data: inserted, error: insErr } = await supabaseAdmin
                    .from('email_replies')
                    .insert({
                        tenant_id: tenantId,
                        campaign_id: emailReply.campaign_id,
                        campaign_name: emailReply.campaign_name,
                        sender_email: emailReply.sender_email,
                        company_id: emailReply.company_id,
                        contact_id: emailReply.contact_id,
                        match_status: emailReply.company_id ? 'matched' : 'unmatched',
                        read_status: 'read' as const,
                        direction: 'OUT' as const,
                        parent_reply_id: id,
                        ...draftPayload,
                    })
                    .select('id')
                    .single();
                if (insErr || !inserted) {
                    log.error({ err: insErr }, 'Failed to save draft');
                    throw new AppError('Failed to save draft', 500);
                }
                draftId = inserted.id;
            }

            log.info({ replyId: id, draftId }, 'Draft saved');
            res.json({ saved: true, draftId });
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Save draft error');
            next(new AppError('Failed to save draft', 500));
        }
    }
);

// GET /api/email-replies/by-company/:companyId — emails linked to a specific company
router.get(
    '/by-company/:companyId',
    requireRole('superadmin', 'ops_agent', 'client_admin'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const tenantId = req.tenantId!;
            const companyId = String(req.params.companyId);

            if (!/^[0-9a-f-]{36}$/i.test(companyId)) {
                res.status(400).json({ error: 'Invalid company ID' });
                return;
            }

            const { data, error } = await supabaseAdmin
                .from('email_replies')
                .select('id, sender_email, reply_body, replied_at, read_status, match_status, campaign_id, campaign_name, company_id, contact_id, category, category_confidence, created_at, tenant_id')
                .eq('tenant_id', tenantId)
                .eq('company_id', companyId)
                .or('raw_payload.is.null,raw_payload->>source.neq.draft')
                .order('replied_at', { ascending: false })
                .limit(100);

            if (error) {
                log.error({ err: error }, 'By-company emails error');
                throw new AppError('Failed to fetch emails', 500);
            }

            const list = data || [];

            // Resolve company name and stage
            let companyName: string | null = null;
            let companyStage: string | null = null;
            const { data: companyRow } = await supabaseAdmin
                .from('companies')
                .select('name, stage')
                .eq('id', companyId)
                .eq('tenant_id', tenantId)
                .single();
            if (companyRow) { companyName = companyRow.name; companyStage = companyRow.stage ?? null; }

            // Resolve contact names
            const contactIds = [...new Set(list.map((r: any) => r.contact_id).filter(Boolean))];
            const contactMap: Record<string, string> = {};
            if (contactIds.length > 0) {
                const { data: contacts } = await supabaseAdmin
                    .from('contacts')
                    .select('id, first_name, last_name')
                    .eq('tenant_id', tenantId)
                    .in('id', contactIds);
                for (const c of contacts || []) {
                    contactMap[c.id] = [c.first_name, c.last_name].filter(Boolean).join(' ');
                }
            }

            const mapped = list.map((r: any) => ({
                ...r,
                company_name: companyName,
                company_stage: companyStage,
                contact_name: r.contact_id ? (contactMap[r.contact_id] || null) : null,
            }));

            res.json(mapped);
        } catch (err) {
            if (err instanceof AppError) return next(err);
            next(new AppError('Failed to fetch emails', 500));
        }
    }
);

// DELETE /api/email-replies/:id — remove a reply (superadmin + ops_agent only)
// Issue 16: allow removal of false positives / test data
router.delete(
    '/:id',
    requireRole('superadmin', 'ops_agent'),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const paramResult = idParamSchema.safeParse(req.params);
            if (!paramResult.success) {
                res.status(400).json({ error: 'Invalid reply ID' });
                return;
            }
            const { id } = paramResult.data;
            const tenantId = req.tenantId!;
            const db = dbClient(req);

            const { error } = await db
                .from('email_replies')
                .delete()
                .eq('id', id)
                .eq('tenant_id', tenantId);

            if (error) {
                log.error({ err: error }, 'Delete email reply error');
                throw new AppError('Failed to delete email reply', 500);
            }

            res.status(204).send();
        } catch (err) {
            if (err instanceof AppError) return next(err);
            log.error({ err }, 'Delete email reply error');
            next(new AppError('Failed to delete email reply', 500));
        }
    }
);

export default router;
